import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";
import { runGit } from "./git/exec.ts";
import {
	EXCLUDE_BLOCK_END,
	EXCLUDE_BLOCK_START,
	renderManagedExclude,
	writeWorkspaceExcludes,
} from "./git-exclude.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "warren-git-exclude-"));
}

/** A clone with one commit, so `git status` and worktrees both work. */
async function initClone(root: string): Promise<string> {
	const clone = join(root, "clone");
	mkdirSync(clone, { recursive: true });
	await runGit(["init", "-q", "-b", "main"], { cwd: clone });
	await runGit(["config", "user.email", "test@warren.invalid"], { cwd: clone });
	await runGit(["config", "user.name", "warren test"], { cwd: clone });
	writeFileSync(join(clone, "README.md"), "hi\n");
	await runGit(["add", "."], { cwd: clone });
	await runGit(["commit", "-qm", "init"], { cwd: clone });
	return clone;
}

async function untracked(cwd: string): Promise<string[]> {
	const res = await runGit(["status", "--porcelain"], { cwd });
	return res.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("??"));
}

describe("renderManagedExclude", () => {
	test("appends a fenced block to an empty file", () => {
		expect(renderManagedExclude("", [".pi/sessions/"])).toBe(
			`${EXCLUDE_BLOCK_START}\n.pi/sessions/\n${EXCLUDE_BLOCK_END}\n`,
		);
	});

	test("preserves lines the operator wrote before the block", () => {
		const out = renderManagedExclude("# operator note\nbuild/\n", [".claude/"]);
		expect(out).toBe(
			`# operator note\nbuild/\n${EXCLUDE_BLOCK_START}\n.claude/\n${EXCLUDE_BLOCK_END}\n`,
		);
	});

	test("replaces an existing block instead of stacking a second one", () => {
		const first = renderManagedExclude("keep/\n", [".pi/sessions/"]);
		const second = renderManagedExclude(first, [".claude/", ".warren/agent.json"]);
		expect(second).toBe(
			`keep/\n${EXCLUDE_BLOCK_START}\n.claude/\n.warren/agent.json\n${EXCLUDE_BLOCK_END}\n`,
		);
		expect(second.split(EXCLUDE_BLOCK_START)).toHaveLength(2);
	});

	test("is idempotent, so a second run against one clone rewrites the same bytes", () => {
		const once = renderManagedExclude("", [".pi/sessions/", ".warren/agent.json"]);
		expect(renderManagedExclude(once, [".pi/sessions/", ".warren/agent.json"])).toBe(once);
	});

	test("keeps operator lines that follow the block", () => {
		const seeded = `${EXCLUDE_BLOCK_START}\nold/\n${EXCLUDE_BLOCK_END}\ntrailing/\n`;
		expect(renderManagedExclude(seeded, ["new/"])).toBe(
			`trailing/\n${EXCLUDE_BLOCK_START}\nnew/\n${EXCLUDE_BLOCK_END}\n`,
		);
	});

	test("drops duplicates and blank entries, keeping caller order", () => {
		const out = renderManagedExclude("", [".pi/", "", "  ", ".pi/", ".warren/agent.json"]);
		expect(out).toBe(`${EXCLUDE_BLOCK_START}\n.pi/\n.warren/agent.json\n${EXCLUDE_BLOCK_END}\n`);
	});

	test("removes the block entirely when no patterns remain", () => {
		const seeded = renderManagedExclude("keep/\n", [".pi/sessions/"]);
		expect(renderManagedExclude(seeded, [])).toBe("keep/\n");
		expect(renderManagedExclude(renderManagedExclude("", [".pi/"]), [])).toBe("");
	});
});

describe("writeWorkspaceExcludes", () => {
	test("hides harness state from git status in a plain clone", async () => {
		const root = tempRoot();
		try {
			const clone = await initClone(root);
			mkdirSync(join(clone, ".pi/sessions"), { recursive: true });
			mkdirSync(join(clone, ".warren"), { recursive: true });
			writeFileSync(join(clone, ".pi/sessions/s.jsonl"), "{}\n");
			writeFileSync(join(clone, ".warren/agent.json"), "{}\n");
			writeFileSync(join(clone, "agent-work.txt"), "real change\n");

			expect(await untracked(clone)).not.toHaveLength(0);
			await writeWorkspaceExcludes(clone, [".pi/sessions/", ".warren/agent.json"]);

			// The agent's actual work still shows; only warren's own files are hidden.
			expect(await untracked(clone)).toEqual(["?? agent-work.txt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("hides harness state in a worktree, where the exclude file is the clone's shared one", async () => {
		const root = tempRoot();
		try {
			const clone = await initClone(root);
			const workspace = join(root, "ws");
			await runGit(["worktree", "add", "-q", workspace, "-b", "run/abc", "main"], {
				cwd: clone,
			});
			mkdirSync(join(workspace, ".pi/sessions"), { recursive: true });
			writeFileSync(join(workspace, ".pi/sessions/s.jsonl"), "{}\n");

			await writeWorkspaceExcludes(workspace, [".pi/sessions/"]);

			expect(await untracked(workspace)).toHaveLength(0);
			// git reads info/exclude as a common path, so the write lands on the
			// parent clone rather than under .git/worktrees/<name>/.
			expect(readFileSync(join(clone, ".git/info/exclude"), "utf8")).toContain(".pi/sessions/");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("leaves an operator's own exclude entries in place", async () => {
		const root = tempRoot();
		try {
			const clone = await initClone(root);
			writeFileSync(join(clone, ".git/info/exclude"), "# mine\nscratch/\n");
			await writeWorkspaceExcludes(clone, [".pi/sessions/"]);
			const written = readFileSync(join(clone, ".git/info/exclude"), "utf8");
			expect(written).toContain("# mine\nscratch/\n");
			expect(written).toContain(".pi/sessions/");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rewrites rather than appends when the same workspace is seeded twice", async () => {
		const root = tempRoot();
		try {
			const clone = await initClone(root);
			await writeWorkspaceExcludes(clone, [".pi/sessions/"]);
			await writeWorkspaceExcludes(clone, [".pi/sessions/"]);
			const written = readFileSync(join(clone, ".git/info/exclude"), "utf8");
			expect(written.split(EXCLUDE_BLOCK_START)).toHaveLength(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("leaves no temp file behind", async () => {
		const root = tempRoot();
		try {
			const clone = await initClone(root);
			await writeWorkspaceExcludes(clone, [".pi/sessions/"]);
			const res = await runGit(["status", "--porcelain", "--ignored"], { cwd: clone });
			expect(res.stdout).not.toContain(".tmp");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("fails loudly when the workspace is not a git repository", async () => {
		const root = tempRoot();
		try {
			await expect(writeWorkspaceExcludes(root, [".pi/sessions/"])).rejects.toThrow(
				WorkspaceMaterializationError,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
