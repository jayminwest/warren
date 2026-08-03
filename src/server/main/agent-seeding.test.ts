import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { Logger } from "../types.ts";
import { seedAgentsAtBoot } from "./agent-seeding.ts";

interface LoggedLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: Record<string, unknown>;
	readonly msg?: string;
}

function recordingLogger(): { lines: LoggedLine[]; logger: Logger } {
	const lines: LoggedLine[] = [];
	const push = (level: LoggedLine["level"]) => (obj: object, msg?: string) =>
		void lines.push({ level, obj: obj as Record<string, unknown>, msg });
	return { lines, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
}

describe("seedAgentsAtBoot", () => {
	let db: WarrenDb;
	let repos: Repos;
	let dir: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		dir = await mkdtemp(join(tmpdir(), "warren-seed-boot-"));
	});
	afterEach(async () => {
		db.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("seeds the built-ins and narrates them", async () => {
		const { lines, logger } = recordingLogger();
		await seedAgentsAtBoot({ repo: repos.agents, env: {}, logger });
		expect(await repos.agents.get("claude-code")).not.toBeNull();
		expect(lines.some((l) => l.msg === "seeded built-in agents")).toBe(true);
		expect(lines.some((l) => l.level === "warn")).toBe(false);
	});

	// warren-c4be: an unknown burrow runtime id in the seed file used to throw
	// past boot, so warren never listened and /healthz never answered.
	test("warns instead of throwing when a seed-file agent is refused", async () => {
		const path = join(dir, "agents.json");
		await writeFile(
			path,
			JSON.stringify([
				{
					name: "stub-shell",
					version: 1,
					sections: { system: "hi" },
					resolvedFrom: [],
					frontmatter: { source: "builtin", runtime: "stub-shell" },
				},
			]),
		);
		const { lines, logger } = recordingLogger();
		await seedAgentsAtBoot({
			repo: repos.agents,
			env: { WARREN_SEED_AGENTS_FILE: path },
			logger,
		});
		expect(await repos.agents.get("stub-shell")).toBeNull();
		const warn = lines.find((l) => l.msg === "refused to seed seed-file agents");
		expect(warn).toBeDefined();
		expect(JSON.stringify(warn?.obj)).toMatch(/is not a known runtime id/);
		// The built-ins still landed — boot completed.
		expect(await repos.agents.get("claude-code")).not.toBeNull();
	});

	test("seeds a seed-file agent whose runtime the operator declared", async () => {
		const path = join(dir, "agents.json");
		await writeFile(
			path,
			JSON.stringify([
				{
					name: "stub-shell",
					version: 1,
					sections: { system: "hi" },
					resolvedFrom: [],
					frontmatter: { source: "builtin", runtime: "stub-shell" },
				},
			]),
		);
		const previous = process.env.WARREN_EXTRA_RUNTIME_IDS;
		process.env.WARREN_EXTRA_RUNTIME_IDS = "stub-shell";
		try {
			const { lines, logger } = recordingLogger();
			await seedAgentsAtBoot({
				repo: repos.agents,
				env: { WARREN_SEED_AGENTS_FILE: path },
				logger,
			});
			expect(await repos.agents.get("stub-shell")).not.toBeNull();
			expect(lines.some((l) => l.level === "warn")).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.WARREN_EXTRA_RUNTIME_IDS;
			else process.env.WARREN_EXTRA_RUNTIME_IDS = previous;
		}
	});
});
