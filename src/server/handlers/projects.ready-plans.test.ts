import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

interface ReadyPlanWire {
	id: string;
	name?: string;
	status: string;
	openChildCount: number;
}

type SpawnFn = (
	cmd: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Build an `sd` spawn stub from canned plan/seed fixtures. Dispatches on
 * the subcommand: `plan list`, `plan show <id>`, and `list`.
 */
function sdSpawnFor(fixtures: {
	plans: { id: string; status: string; name?: string }[];
	planChildren: Record<string, string[]>;
	seedStatuses: Record<string, string>;
}): { spawn: SpawnFn; calls: (readonly string[])[] } {
	const calls: (readonly string[])[] = [];
	const spawn: SpawnFn = async (cmd) => {
		calls.push(cmd);
		const [, sub, third] = cmd;
		if (sub === "plan" && third === "list") {
			return {
				stdout: JSON.stringify({ success: true, plans: fixtures.plans }),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "plan" && third === "show") {
			const planId = cmd[3] ?? "";
			return {
				stdout: JSON.stringify({
					success: true,
					plan: { id: planId, status: "approved", children: fixtures.planChildren[planId] ?? [] },
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "list") {
			const issues = Object.entries(fixtures.seedStatuses).map(([id, status]) => ({ id, status }));
			return { stdout: JSON.stringify({ success: true, issues }), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

describe("GET /projects/:id/ready-plans — ready-to-dispatch plans (warren-f716)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";
	let bareProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy-warren-f716",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		const bare = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare-warren-f716",
			defaultBranch: "main",
			hasSeeds: false,
		});
		bareProjectId = bare.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function silentBurrow(): BurrowClient {
		return new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
	}

	async function depsWithSpawn(spawn: SpawnFn): Promise<ServerDeps> {
		const base = await depsFor(repos, silentBurrow());
		return { ...base, seedsCli: { sdBinary: "sd", spawn } };
	}

	function serve(deps: ServerDeps): ServeHandle {
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return handle;
	}

	test("surfaces an approved plan with open children", async () => {
		const { spawn } = sdSpawnFor({
			plans: [{ id: "pl-ready", status: "approved", name: "Ready One" }],
			planChildren: { "pl-ready": ["warren-aaaa", "warren-bbbb"] },
			seedStatuses: { "warren-aaaa": "open", "warren-bbbb": "closed" },
		});
		const h = serve(await depsWithSpawn(spawn));

		const res = await fetch(`${tcpUrl(h)}/projects/${seedyProjectId}/ready-plans`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: ReadyPlanWire[] };
		expect(body.plans).toEqual([
			{ id: "pl-ready", name: "Ready One", status: "approved", openChildCount: 1 },
		]);
	});

	test("hides a plan whose children are all closed", async () => {
		const { spawn } = sdSpawnFor({
			plans: [{ id: "pl-done", status: "approved" }],
			planChildren: { "pl-done": ["warren-cccc"] },
			seedStatuses: { "warren-cccc": "closed" },
		});
		const h = serve(await depsWithSpawn(spawn));

		const res = await fetch(`${tcpUrl(h)}/projects/${seedyProjectId}/ready-plans`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: ReadyPlanWire[] };
		expect(body.plans).toEqual([]);
	});

	test("hides a plan that already has a plan_run row", async () => {
		const { spawn } = sdSpawnFor({
			plans: [{ id: "pl-disp", status: "approved" }],
			planChildren: { "pl-disp": ["warren-dddd"] },
			seedStatuses: { "warren-dddd": "open" },
		});
		await repos.planRuns.create({
			projectId: seedyProjectId,
			planId: "pl-disp",
			agentName: "refactor-bot",
			children: [{ seq: 0, seedId: "warren-dddd" }],
		});
		const h = serve(await depsWithSpawn(spawn));

		const res = await fetch(`${tcpUrl(h)}/projects/${seedyProjectId}/ready-plans`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: ReadyPlanWire[] };
		expect(body.plans).toEqual([]);
	});

	test("400 ProjectLacksSeedsError for a non-seeds project", async () => {
		const { spawn } = sdSpawnFor({ plans: [], planChildren: {}, seedStatuses: {} });
		const h = serve(await depsWithSpawn(spawn));

		const res = await fetch(`${tcpUrl(h)}/projects/${bareProjectId}/ready-plans`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});
});
