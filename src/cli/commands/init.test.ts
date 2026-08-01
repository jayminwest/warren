import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../../db/repos/projects.ts";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { parseConfigFile, parseTriggersConfig } from "../../warren-config/schema.ts";
import type { CliContext } from "../output.ts";
import { runInit } from "./init.ts";

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env: {},
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

describe("runInit (--cwd mode)", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;
	let agents: AgentsRepo;
	let tmp: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		projects = new ProjectsRepo(DrizzleAdapter.for(db));
		agents = new AgentsRepo(DrizzleAdapter.for(db));
		tmp = await mkdtemp(join(tmpdir(), "warren-init-test-"));
	});

	afterEach(async () => {
		await db.close();
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds parseable triggers.yaml + config.yaml (round-trip)", async () => {
		// One agent registered → auto-fills defaultRole.
		await agents.upsert({ name: "claude-code", renderedJson: {} });
		const { context, out } = captureContext();
		const result = await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);
		const stdout = JSON.parse(out.join(""));
		expect(stdout.ok).toBe(true);
		expect(stdout.scaffolded.defaultRole).toBe("claude-code");
		expect(stdout.scaffolded.files).toEqual([".warren/triggers.yaml", ".warren/config.yaml"]);

		const triggersRaw = await readFile(join(tmp, ".warren/triggers.yaml"), "utf8");
		const triggersParsed = parseTriggersConfig(load(triggersRaw));
		expect(triggersParsed.ok).toBe(true);
		if (triggersParsed.ok) expect(triggersParsed.value).toEqual([]);

		const configRaw = await readFile(join(tmp, ".warren/config.yaml"), "utf8");
		const configParsed = parseConfigFile(load(configRaw));
		expect(configParsed.ok).toBe(true);
		if (configParsed.ok) expect(configParsed.value).toEqual({ defaultRole: "claude-code" });
	});

	test("omits defaultRole when multiple agents are registered", async () => {
		// Mimic the real boot path — seedBuiltinAgents registers >1 agent.
		await seedBuiltinAgents(agents);
		const { context, out } = captureContext();
		const result = await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);
		const configRaw = await readFile(join(tmp, ".warren/config.yaml"), "utf8");
		// Empty config renders as a YAML flow-style empty mapping `{}` so the
		// file round-trips back through the schema to an empty DefaultsConfig.
		expect(load(configRaw)).toEqual({});
		expect(JSON.parse(out.join("")).scaffolded.defaultRole).toBeNull();
	});

	test("honors --default-role when the agent exists", async () => {
		await seedBuiltinAgents(agents);
		const { context } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: tmp, defaultRole: "sapling" },
		);
		expect(result.exitCode).toBe(0);
		const config = load(await readFile(join(tmp, ".warren/config.yaml"), "utf8")) as {
			defaultRole?: string;
		};
		expect(config.defaultRole).toBe("sapling");
	});

	test("rejects an unknown --default-role with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: tmp, defaultRole: "nope" },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("unknown agent");
		expect(existsSync(join(tmp, ".warren"))).toBe(false);
	});

	test("refuses to overwrite an existing .warren/triggers.yaml", async () => {
		const { context, err } = captureContext();
		await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		const { context: ctx2, err: err2 } = captureContext();
		const second = await runInit(ctx2, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(second.exitCode).toBe(2);
		expect(err2.join("")).toContain("refusing to overwrite");
		// First run shouldn't have written errors.
		expect(err.join("")).toBe("");
	});

	test("refuses to scaffold over legacy .warren/defaults.json", async () => {
		await mkdir(join(tmp, ".warren"), { recursive: true });
		await writeFile(join(tmp, ".warren/defaults.json"), JSON.stringify({ defaultBranch: "main" }));
		const { context, err } = captureContext();
		const result = await runInit(context, { projects, agents }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("warren config migrate");
		expect(existsSync(join(tmp, ".warren/config.yaml"))).toBe(false);
	});

	test("rejects a non-existent --cwd path with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "cwd", cwd: join(tmp, "does-not-exist") },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("does not exist");
	});
});

describe("runInit (--project mode)", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;
	let agents: AgentsRepo;
	let tmp: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		projects = new ProjectsRepo(DrizzleAdapter.for(db));
		agents = new AgentsRepo(DrizzleAdapter.for(db));
		tmp = await mkdtemp(join(tmpdir(), "warren-init-prj-"));
	});

	afterEach(async () => {
		await db.close();
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds into the project's local clone", async () => {
		await agents.upsert({ name: "claude-code", renderedJson: {} });
		const row = await projects.create({
			gitUrl: "https://github.com/example/init-target",
			localPath: tmp,
			defaultBranch: "main",
		});
		const { context } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: row.id },
		);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(tmp, ".warren/triggers.yaml"))).toBe(true);
		expect(existsSync(join(tmp, ".warren/config.yaml"))).toBe(true);
	});

	test("rejects an unknown project id with exit 1", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: "prj_missing" },
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("project not found");
	});

	test("rejects a project whose clone is missing on disk with exit 2", async () => {
		const missing = join(tmp, "vanished");
		const row = await projects.create({
			gitUrl: "https://github.com/example/vanished",
			localPath: missing,
			defaultBranch: "main",
		});
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ projects, agents },
			{ mode: "project", projectId: row.id },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("missing on disk");
	});
});
