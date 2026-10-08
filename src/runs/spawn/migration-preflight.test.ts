import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnResult } from "../../projects/clone.ts";
import {
	appendMigrationCollisionNote,
	composeMigrationCollisionNote,
	detectMigrationJournalCollisions,
	findCollisions,
	MigrationPreflightError,
	type MigrationPreflightInput,
} from "./migration-preflight.ts";

/**
 * warren-1f03 / warren-4371: dispatch-time drizzle migration journal
 * preflight. Detection compares the branch's journal entries against fresh
 * main's; a branch migration whose index/tag also exists on main with a
 * different tag is a collision. Detection is read-only on the host: it never
 * runs a repository-defined script, never writes to the clone, and never
 * commits — the run regenerates inside its sandbox.
 */

const SQLITE_DIR = "src/db/migrations";
const SQLITE_JOURNAL = `${SQLITE_DIR}/meta/_journal.json`;

/** The only commands the host-side detection may run: read-only git plumbing. */
const READ_ONLY_GIT = new Set(["ls-files", "cat-file"]);

interface SpawnCall {
	readonly cmd: readonly string[];
	readonly cwd: string;
}

function makeSpawn(
	mainJournal: unknown | null,
	journals: readonly string[] = [SQLITE_JOURNAL],
): { spawn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = async (cmd, opts): Promise<SpawnResult> => {
		calls.push({ cmd, cwd: opts.cwd });
		const joined = cmd.join(" ");
		if (joined.includes("ls-files")) {
			return { stdout: `${journals.join("\n")}\n`, stderr: "", exitCode: 0 };
		}
		if (joined.includes("cat-file") && joined.includes(SQLITE_JOURNAL)) {
			if (mainJournal === null) {
				return { stdout: "", stderr: "does not exist", exitCode: 128 };
			}
			return { stdout: JSON.stringify(mainJournal), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

function journal(entries: { idx: number; tag: string }[]): unknown {
	return {
		version: "7",
		dialect: "sqlite",
		entries: entries.map((e) => ({ ...e, version: "6", when: 1, breakpoints: true })),
	};
}

async function seedBranchTree(
	root: string,
	entries: { idx: number; tag: string }[],
): Promise<void> {
	await mkdir(join(root, SQLITE_DIR, "meta"), { recursive: true });
	await writeFile(join(root, SQLITE_JOURNAL), JSON.stringify(journal(entries)));
	for (const entry of entries) {
		await writeFile(join(root, SQLITE_DIR, `${entry.tag}.sql`), `-- ${entry.tag}\n`);
		await writeFile(
			join(root, SQLITE_DIR, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`),
			JSON.stringify({ tag: entry.tag }),
		);
	}
}

/** Snapshot every file under the migrations dir so a test can prove no mutation. */
async function treeSnapshot(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const sub of [SQLITE_DIR, `${SQLITE_DIR}/meta`]) {
		for (const name of await readdir(join(root, sub))) {
			if (name === "meta") continue;
			out[`${sub}/${name}`] = await readFile(join(root, sub, name), "utf8");
		}
	}
	return out;
}

describe("findCollisions (warren-1f03)", () => {
	test("flags a branch entry whose idx exists on main with a different tag", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 46, tag: "0046_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
	});

	test("passes a branch entry at a slot past main's tip", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 47, tag: "0047_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([]);
	});
});

describe("detectMigrationJournalCollisions (warren-4371)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "warren-4371-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function input(spawn: SpawnFn): MigrationPreflightInput {
		return { spawn, projectPath: root, defaultBranch: "main", baseRef: "burrow/run_xxx" };
	}

	test("no migrations on the branch reports no collisions", async () => {
		const { spawn } = makeSpawn(null, []);
		expect(await detectMigrationJournalCollisions(input(spawn))).toEqual({ collisions: [] });
	});

	test("a branch migration at a free slot past main's tip reports no collisions", async () => {
		await seedBranchTree(root, [
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_branch" },
		]);
		const { spawn } = makeSpawn(journal([{ idx: 45, tag: "0045_main" }]));
		expect(await detectMigrationJournalCollisions(input(spawn))).toEqual({ collisions: [] });
	});

	test("a detected collision runs only read-only git plumbing and leaves the clone untouched", async () => {
		await seedBranchTree(root, [
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_branch" },
		]);
		const before = await treeSnapshot(root);
		const { spawn, calls } = makeSpawn(
			journal([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_main" },
			]),
		);

		const outcome = await detectMigrationJournalCollisions(input(spawn));

		expect(outcome.collisions).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
		// No repository-defined script, no package manager, no commit: every
		// spawned command is `git ls-files` or `git cat-file`.
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.cmd[0]).toBe("git");
			expect(READ_ONLY_GIT.has(call.cmd[1] ?? "")).toBe(true);
		}
		const joined = calls.map((c) => c.cmd.join(" "));
		expect(joined.some((c) => c.includes("db:generate"))).toBe(false);
		expect(joined.some((c) => /\b(commit|add|bun|npm)\b/.test(c))).toBe(false);
		// The host clone's migration tree is byte-identical afterwards.
		expect(await treeSnapshot(root)).toEqual(before);
	});

	test("a failed journal listing surfaces a typed MigrationPreflightError", async () => {
		const failing: SpawnFn = async () => ({ stdout: "", stderr: "not a git repo", exitCode: 128 });
		await expect(detectMigrationJournalCollisions(input(failing))).rejects.toBeInstanceOf(
			MigrationPreflightError,
		);
	});
});

describe("composeMigrationCollisionNote (warren-4371)", () => {
	const collisions = [
		{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
	];

	test("quotes the project's configured regenerate command for the agent", () => {
		const note = composeMigrationCollisionNote(collisions, "main", "bun run db:generate");
		expect(note).toContain("`0046_branch` (idx 46) collides with `0046_main` on `origin/main`");
		expect(note).toContain("run `bun run db:generate`");
		expect(note).toContain("Warren did not modify the branch");
	});

	test("imposes no command convention when the project configures none", () => {
		const note = composeMigrationCollisionNote(collisions, "trunk", undefined);
		expect(note).toContain("run this project's migration generator");
		expect(note).not.toContain("db:generate");
		expect(note).toContain("`origin/trunk`");
	});

	test("appendMigrationCollisionNote is the identity when there is no note", () => {
		expect(appendMigrationCollisionNote("prompt", null)).toBe("prompt");
		expect(appendMigrationCollisionNote("prompt", "note")).toBe("prompt\n\n---\n\nnote");
	});
});
