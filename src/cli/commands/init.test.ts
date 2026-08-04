import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { type WarrenClient, WarrenClientError } from "../../client/index.ts";
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

interface MockClientInput {
	readonly agents?: readonly { readonly name: string }[];
	readonly projects?: Readonly<Record<string, { readonly localPath: string }>>;
}

/** Mocked WarrenClient (warren-97a2): the CLI no longer opens a DB. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	const agents = input.agents ?? [];
	const projects = input.projects ?? {};
	return {
		listAgents: async () => ({ agents: agents.map((a) => ({ name: a.name })) }),
		getAgent: async (name: string) => {
			const found = agents.find((a) => a.name === name);
			if (found === undefined) throw new WarrenClientError(404, "not_found", "agent not found");
			return { name: found.name };
		},
		getProject: async (id: string) => {
			const found = projects[id];
			if (found === undefined) throw new WarrenClientError(404, "not_found", "project not found");
			return found;
		},
	} as unknown as WarrenClient;
}

describe("runInit (--cwd mode)", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "warren-init-test-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds parseable triggers.yaml + config.yaml (round-trip)", async () => {
		// One agent registered → auto-fills defaultRole.
		const client = mockClient({ agents: [{ name: "claude-code" }] });
		const { context, out } = captureContext();
		const result = await runInit(context, { client }, { mode: "cwd", cwd: tmp });
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
		const client = mockClient({ agents: [{ name: "claude-code" }, { name: "sapling" }] });
		const { context, out } = captureContext();
		const result = await runInit(context, { client }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(0);
		const configRaw = await readFile(join(tmp, ".warren/config.yaml"), "utf8");
		// Empty config renders as a YAML flow-style empty mapping `{}` so the
		// file round-trips back through the schema to an empty DefaultsConfig.
		expect(load(configRaw)).toEqual({});
		expect(JSON.parse(out.join("")).scaffolded.defaultRole).toBeNull();
	});

	test("honors --default-role when the agent exists", async () => {
		const client = mockClient({ agents: [{ name: "claude-code" }, { name: "sapling" }] });
		const { context } = captureContext();
		const result = await runInit(
			context,
			{ client },
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
			{ client: mockClient() },
			{ mode: "cwd", cwd: tmp, defaultRole: "nope" },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("unknown agent");
		expect(existsSync(join(tmp, ".warren"))).toBe(false);
	});

	test("refuses to overwrite an existing .warren/triggers.yaml", async () => {
		const client = mockClient();
		const { context, err } = captureContext();
		await runInit(context, { client }, { mode: "cwd", cwd: tmp });
		const { context: ctx2, err: err2 } = captureContext();
		const second = await runInit(ctx2, { client }, { mode: "cwd", cwd: tmp });
		expect(second.exitCode).toBe(2);
		expect(err2.join("")).toContain("refusing to overwrite");
		// First run shouldn't have written errors.
		expect(err.join("")).toBe("");
	});

	test("refuses to scaffold over legacy .warren/defaults.json", async () => {
		await mkdir(join(tmp, ".warren"), { recursive: true });
		await writeFile(join(tmp, ".warren/defaults.json"), JSON.stringify({ defaultBranch: "main" }));
		const { context, err } = captureContext();
		const result = await runInit(context, { client: mockClient() }, { mode: "cwd", cwd: tmp });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("warren config migrate");
		expect(existsSync(join(tmp, ".warren/config.yaml"))).toBe(false);
	});

	test("rejects a non-existent --cwd path with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ client: mockClient() },
			{ mode: "cwd", cwd: join(tmp, "does-not-exist") },
		);
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("does not exist");
	});
});

describe("runInit (--project mode)", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "warren-init-prj-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	test("scaffolds into the project's local clone", async () => {
		const client = mockClient({
			agents: [{ name: "claude-code" }],
			projects: { prj_1: { localPath: tmp } },
		});
		const { context } = captureContext();
		const result = await runInit(context, { client }, { mode: "project", projectId: "prj_1" });
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(tmp, ".warren/triggers.yaml"))).toBe(true);
		expect(existsSync(join(tmp, ".warren/config.yaml"))).toBe(true);
	});

	test("rejects an unknown project id with exit 1", async () => {
		const { context, err } = captureContext();
		const result = await runInit(
			context,
			{ client: mockClient() },
			{ mode: "project", projectId: "prj_missing" },
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("project not found");
	});

	test("rejects a project whose clone is missing on disk with exit 2", async () => {
		const missing = join(tmp, "vanished");
		const client = mockClient({ projects: { prj_1: { localPath: missing } } });
		const { context, err } = captureContext();
		const result = await runInit(context, { client }, { mode: "project", projectId: "prj_1" });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("missing on disk");
	});
});
