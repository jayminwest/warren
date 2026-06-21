import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

interface PlanSummaryWire {
	id: string;
	status: string;
	seed?: string;
	template?: string;
	revision?: number;
	name?: string;
	childCount: number;
	createdAt?: string;
	updatedAt?: string;
}

describe("GET /projects/:id/seeds/plans — list a project's seeds plans (warren-9b49)", () => {
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
			localPath: "/tmp/seedy-warren-9b49",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		const bare = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare-warren-9b49",
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

	function depsWithSdSpawn(
		burrowClient: BurrowClient,
		sdSpawn: (
			cmd: readonly string[],
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	): Promise<ServerDeps> {
		return (async () => {
			const base = await depsFor(repos, burrowClient);
			return { ...base, seedsCli: { sdBinary: "sd", spawn: sdSpawn } };
		})();
	}

	function silentBurrow(): BurrowClient {
		return new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
	}

	test("returns lean plan summaries and shells out to `sd plan list --json`", async () => {
		const calls: (readonly string[])[] = [];
		const deps = await depsWithSdSpawn(silentBurrow(), async (cmd) => {
			calls.push(cmd);
			return {
				stdout: JSON.stringify({
					success: true,
					command: "plan list",
					count: 1,
					plans: [
						{
							id: "pl-dfb5",
							seed: "warren-1551",
							template: "feature",
							status: "approved",
							revision: 1,
							name: "UI Nits Redux",
							children: ["warren-9440", "warren-5562"],
							createdAt: "2026-06-16T07:18:51.397Z",
							updatedAt: "2026-06-16T07:18:51.397Z",
							sections: { context: "huge body".repeat(200) },
						},
					],
				}),
				stderr: "",
				exitCode: 0,
			};
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/plans`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: PlanSummaryWire[] };
		expect(calls[0]).toEqual(["sd", "plan", "list", "--json"]);
		expect(body.plans).toEqual([
			{
				id: "pl-dfb5",
				status: "approved",
				seed: "warren-1551",
				template: "feature",
				revision: 1,
				name: "UI Nits Redux",
				childCount: 2,
				createdAt: "2026-06-16T07:18:51.397Z",
				updatedAt: "2026-06-16T07:18:51.397Z",
			},
		]);
	});

	test("returns an empty array for a project with no plans", async () => {
		const deps = await depsWithSdSpawn(silentBurrow(), async () => ({
			stdout: JSON.stringify({ success: true, plans: [] }),
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/plans`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plans: PlanSummaryWire[] };
		expect(body.plans).toEqual([]);
	});

	test("404 for unknown project id", async () => {
		const deps = await depsWithSdSpawn(silentBurrow(), async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_missing/seeds/plans`);
		expect(res.status).toBe(404);
	});

	test("400 ProjectLacksSeedsError when project has no .seeds/", async () => {
		const deps = await depsWithSdSpawn(silentBurrow(), async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${bareProjectId}/seeds/plans`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});

	test("400 ValidationError when seeds CLI is not configured on warren", async () => {
		const deps = await depsFor(repos, silentBurrow());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/plans`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("`plans` is not swallowed by the :seedId param route", async () => {
		const calls: (readonly string[])[] = [];
		const deps = await depsWithSdSpawn(silentBurrow(), async (cmd) => {
			calls.push(cmd);
			return { stdout: JSON.stringify({ success: true, plans: [] }), stderr: "", exitCode: 0 };
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/plans`);
		expect(res.status).toBe(200);
		// `sd plan list`, not `sd show plans` — confirms route precedence.
		expect(calls[0]).toEqual(["sd", "plan", "list", "--json"]);
	});
});
