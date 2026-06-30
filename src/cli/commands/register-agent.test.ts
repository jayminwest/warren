import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { CanopyClient, type SpawnFn, type SpawnResult } from "../../registry/canopy.ts";
import type { CanopyRegistryConfig } from "../../registry/config.ts";
import type { CliContext } from "../output.ts";
import { runRegisterAgent } from "./register-agent.ts";

const CFG: CanopyRegistryConfig = {
	repoUrl: "https://example.com/agents.git",
	localDir: "/tmp/canopy-cli",
	cnBinary: "cn",
	gitBinary: "git",
};

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async (): Promise<SpawnResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

function buildSpawn(listResp: unknown, renderResponses: Record<string, unknown>): SpawnFn {
	return async (cmd) => {
		const head = cmd[0] ?? "";
		// Treat any "git" call as a no-op (registry's clone path), so the
		// existsSync-based clone short-circuits past actual git work.
		if (head === "git" || head.endsWith("git")) {
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		if (cmd[1] === "list") {
			return { stdout: JSON.stringify(listResp), stderr: "", exitCode: 0 };
		}
		if (cmd[1] === "render") {
			const name = cmd[2] as string;
			const handler = renderResponses[name];
			if (handler === undefined) {
				return { stdout: "", stderr: `unhandled render: ${name}`, exitCode: 2 };
			}
			return { stdout: JSON.stringify(handler), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "unexpected", exitCode: 1 };
	};
}

function rendered(name: string, sections: Record<string, string>, version = 1): unknown {
	return {
		success: true,
		command: "render",
		name,
		version,
		sections: Object.entries(sections).map(([n, body]) => ({ name: n, body })),
	};
}

describe("runRegisterAgent", () => {
	let db: WarrenDb;
	let agents: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		agents = new AgentsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("registers the named agent and exits 0", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "refactor-bot", version: 2, status: "active" },
					{ name: "docs-bot", version: 1, status: "active" },
				],
			},
			{
				"refactor-bot": rendered("refactor-bot", { system: "refactor" }, 2),
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });
		const { context, out, err } = captureContext();

		const result = await runRegisterAgent(
			context,
			{ agents, canopyConfig: CFG, canopyClient: client },
			{ name: "refactor-bot" },
		);

		expect(result.exitCode).toBe(0);
		expect(err).toHaveLength(0);
		const line = JSON.parse(out[0] as string);
		expect(line.ok).toBe(true);
		expect(line.agent).toBe("refactor-bot");
		// docs-bot was filtered out by the proxy and never registered.
		expect((await agents.listAll()).map((r) => r.name)).toEqual(["refactor-bot"]);
	});

	test("exits 1 with code 'agent_not_found' when the named prompt isn't tagged 'agent'", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
			},
			{},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });
		const { context, out, err } = captureContext();

		const result = await runRegisterAgent(
			context,
			{ agents, canopyConfig: CFG, canopyClient: client },
			{ name: "missing" },
		);

		expect(result.exitCode).toBe(1);
		expect(err).toHaveLength(0);
		const line = JSON.parse(out[0] as string);
		expect(line.code).toBe("agent_not_found");
		expect(await agents.listAll()).toHaveLength(0);
	});

	test("surfaces a per-agent schema error in skipped[]", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "broken", version: 1, status: "active" }],
			},
			{
				// Render returns an envelope without a 'system' section → AgentSchemaError.
				broken: { success: true, command: "render", name: "broken", version: 1, sections: [] },
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });
		const { context, out, err } = captureContext();

		const result = await runRegisterAgent(
			context,
			{ agents, canopyConfig: CFG, canopyClient: client },
			{ name: "broken" },
		);

		expect(result.exitCode).toBe(1);
		expect(err).toHaveLength(0);
		const line = JSON.parse(out[0] as string);
		expect(line.ok).toBe(false);
		expect(line.code).toBe("agent_schema_error");
	});

	test("rejects empty name with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runRegisterAgent(context, { agents, canopyConfig: CFG }, { name: "" });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("agent name is required");
	});
});
