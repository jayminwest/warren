import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { PlotResolver } from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function poolFor(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(async () => jsonRes(404, { error: { code: "not_found", message: "stub" } })),
	});
	pool.register("local", client);
	return pool;
}

interface BuildDepsInput {
	repos: Repos;
	plotResolver?: PlotResolver;
	plotSyncer?: import("../../plots/index.ts").PlotSyncer;
}

async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos: input.repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
		...(input.plotSyncer !== undefined ? { plotSyncer: input.plotSyncer } : {}),
	};
}

function fakeResolver(map: Record<string, ProjectRow | null>): {
	resolver: PlotResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const resolver: PlotResolver = {
		async resolve(plotId) {
			calls.push(plotId);
			return map[plotId] ?? null;
		},
	};
	return { resolver, calls };
}

async function seedProject(
	repos: Repos,
	over: Partial<ProjectRow> & { id: string },
): Promise<ProjectRow> {
	return repos.projects.create({
		id: over.id,
		gitUrl: over.gitUrl ?? `https://example.test/${over.id}.git`,
		defaultBranch: over.defaultBranch ?? "main",
		localPath: over.localPath ?? `/tmp/projects/${over.id}`,
		hasPlot: over.hasPlot ?? false,
		hasSeeds: over.hasSeeds ?? false,
	});
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("POST /plots/:id/sync", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("returns the synced result when successful", async () => {
		const project = await seedProject(repos, { id: "proj-sync", hasPlot: true });
		const { resolver } = fakeResolver({ "plot-sync-01": project });
		const mockSyncer: import("../../plots/index.ts").PlotSyncer = {
			async sync(_input) {
				return {
					kind: "synced",
					branch: "warren/plot-sync-xyz",
					prUrl: "https://github.com/owner/repo/pull/1",
					merged: true,
				};
			},
		};

		const deps = await depsFor({ repos, plotResolver: resolver, plotSyncer: mockSyncer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-sync-01/sync`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			kind: "synced",
			branch: "warren/plot-sync-xyz",
			prUrl: "https://github.com/owner/repo/pull/1",
			merged: true,
		});
	});

	test("returns 404 for non-existent plot id", async () => {
		const deps = await depsFor({ repos });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-missing-01/sync`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(404);
	});

	test("returns error when project lacks plot directory", async () => {
		const project = await seedProject(repos, { id: "proj-noplot", hasPlot: false });
		const { resolver } = fakeResolver({ "plot-noplot-01": project });
		const deps = await depsFor({ repos, plotResolver: resolver });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/plot-noplot-01/sync`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400); // ProjectLacksPlotError -> 400
	});
});
