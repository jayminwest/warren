/**
 * Two-worker integration test (warren-a801 / pl-9ba1 step 10, parent
 * warren-6747). Boots a real warren HTTP server in front of a
 * `BurrowClientPool` containing two stubbed burrow workers and drives the
 * three acceptance scenarios end-to-end through HTTP:
 *
 *   - project-affinity: two `POST /runs` for the same project land on the
 *     same worker (after a prior succeeded run set affinity), while a
 *     run for a different project flows to the least-loaded worker.
 *   - failover-on-drain: `POST /workers/A/drain` issues `/admin/drain` to
 *     worker A, flips warren's state to `draining`, and the next dispatch
 *     for an A-affinity project lands on B; the orphaned burrow already
 *     pinned to A continues to serve via sticky-by-burrow.
 *   - cross-worker fan-out: `GET /burrows` unions per-worker results,
 *     sorts by `createdAt`, and surfaces a `workerErrors` envelope plus a
 *     `worker_unreachable` log line when a worker is unreachable mid-list.
 *
 * The per-aspect handlers tests (`handlers.workers.test.ts`,
 * `handlers.burrows.test.ts`, `placement.test.ts`) cover each piece in
 * isolation. This file ties them together against the same pool to prove
 * the wiring composes — placement decisions flow through to the stub
 * worker's recorded calls, drain mutates state used by the very next
 * placement, fan-out reads the same in-memory burrow registry the spawn
 * flow populated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { NO_AUTH } from "./auth.ts";
import { jsonResponse } from "./response.ts";
import { startServer } from "./server.ts";
import type { BridgeRegistry, Logger, ServeHandle, ServerDeps } from "./types.ts";

interface StubBurrow {
	id: string;
	createdAt: string;
	projectRoot: string;
	branch: string;
	state: string;
}

interface WorkerState {
	readonly burrows: Map<string, StubBurrow>;
	readonly calls: { method: string; path: string; body: unknown; auth: string | null }[];
	killed: boolean;
	counter: number;
}

/**
 * Monotonic clock shared across both stub workers so `createdAt` reflects
 * call order globally. Without this, each worker stamps from its own
 * per-instance counter and a B-burrow created after two A-burrows ties on
 * the first minute — breaking the createdAt-asc sort assertion in
 * fan-out tests.
 */
function makeClock(): () => string {
	let n = 0;
	return () => {
		n += 1;
		return new Date(Date.UTC(2026, 4, 13, 12, 0, 0) + n * 1000).toISOString();
	};
}

interface StubWorker {
	readonly state: WorkerState;
	readonly client: BurrowClient;
}

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

/**
 * Build a stub burrow worker that round-trips state in-memory so the same
 * worker that handles `POST /burrows` for a run later returns that
 * burrow on `GET /burrows`. Two workers in the pool therefore present
 * independent in-memory registries — the fan-out helper has something
 * non-trivial to union, and `worker_unreachable` flips a single boolean
 * to simulate a killed worker.
 *
 * The stub honours the bearer token threaded by `BurrowClientPool.fromConfig`
 * (recorded on every call so the test can assert the shared token reached
 * burrow). The seed payload that rides `POST /burrows` is ignored — the
 * spawn flow's seed validation already exercises that path in
 * `runs/spawn.test.ts`; here we only need the up call to succeed and
 * the resulting burrow id to be recoverable on later fan-out reads.
 */
function makeStubWorker(name: string, token: string, clock: () => string): StubWorker {
	const state: WorkerState = {
		burrows: new Map(),
		calls: [],
		killed: false,
		counter: 0,
	};

	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: `/tmp/${name}.sock` }, token },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
			state.calls.push({ method, path, body: reqBody, auth });

			if (state.killed) {
				const err = new TypeError("fetch failed");
				(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
				throw err;
			}

			if (method === "POST" && path === "/burrows") {
				state.counter += 1;
				const burrow: StubBurrow = {
					id: `bur_${name}${String(state.counter).padStart(8, "0").slice(-8)}aa`,
					createdAt: clock(),
					projectRoot: (reqBody as { projectRoot?: string } | undefined)?.projectRoot ?? "",
					branch: (reqBody as { branch?: string } | undefined)?.branch ?? "main",
					state: "active",
				};
				state.burrows.set(burrow.id, burrow);
				return jsonResponse(201, serializeBurrowFull(burrow));
			}

			const runMatch = /^\/burrows\/([^/]+)\/runs$/.exec(path);
			if (method === "POST" && runMatch) {
				const burrowId = decodeURIComponent(runMatch[1] ?? "");
				const runId = `run_${name}${String(state.counter).padStart(8, "0").slice(-8)}aa`;
				return jsonResponse(201, {
					id: runId,
					burrowId,
					agentId: (reqBody as { agentId?: string } | undefined)?.agentId ?? "refactor-bot",
					prompt: (reqBody as { prompt?: string } | undefined)?.prompt ?? "",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: new Date().toISOString(),
					startedAt: null,
					completedAt: null,
				});
			}

			if (method === "GET" && path === "/burrows") {
				const rows = [...state.burrows.values()].map(serializeBurrowList);
				return jsonResponse(200, rows);
			}

			const getMatch = /^\/burrows\/([^/]+)$/.exec(path);
			if (method === "GET" && getMatch) {
				const id = decodeURIComponent(getMatch[1] ?? "");
				const burrow = state.burrows.get(id);
				if (burrow === undefined) {
					return jsonResponse(404, {
						error: { code: "not_found", message: `burrow ${id} not found` },
					});
				}
				return jsonResponse(200, serializeBurrowList(burrow));
			}

			if (method === "POST" && path === "/admin/drain") {
				const drain = (reqBody as { drain: boolean }).drain;
				return jsonResponse(200, { drain });
			}

			return jsonResponse(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});

	return { state, client };
}

/**
 * Wire-shape for `POST /burrows` responses — mirrors `Burrow` as the
 * burrow-cli HTTP schema parses it (see `runs/spawn.test.ts`). Includes
 * the `providerStateJson` / `profileJson` / `destroyedAt` fields the up
 * envelope schema requires.
 */
function serializeBurrowFull(r: StubBurrow): Record<string, unknown> {
	return {
		id: r.id,
		parentId: null,
		kind: "task",
		name: null,
		projectRoot: r.projectRoot,
		workspacePath: `/data/burrow/workspaces/${r.id}`,
		branch: r.branch,
		provider: "local",
		providerStateJson: null,
		profileJson: {},
		state: r.state,
		createdAt: r.createdAt,
		updatedAt: r.createdAt,
		destroyedAt: null,
	};
}

/**
 * Wire-shape for `GET /burrows` / `GET /burrows/:id` responses — the list
 * schema accepts a slightly different envelope (see
 * `server/handlers.burrows.test.ts`'s `burrowWire`).
 */
function serializeBurrowList(r: StubBurrow): Record<string, unknown> {
	return {
		id: r.id,
		name: r.id,
		kind: "task",
		projectRoot: r.projectRoot,
		branch: r.branch,
		baseBranch: "main",
		originUrl: "https://github.com/x/y.git",
		workspacePath: `/data/burrow/workspaces/${r.id}`,
		provider: "local",
		sandbox: { network: "open" },
		state: r.state,
		createdAt: r.createdAt,
		updatedAt: r.createdAt,
	};
}

function depsFor(repos: Repos, pool: BurrowClientPool, logger: Logger): ServerDeps {
	// Inert bridge so `POST /runs` doesn't open a real event stream against
	// the stub. The bridge wiring itself is exercised by handlers.test.ts.
	const bridges: BridgeRegistry = {
		start: () => {},
		stopAll: async () => {},
		size: () => 0,
	};
	return {
		repos,
		burrowClientPool: pool,
		broker: new RunEventBroker(),
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger,
		uiDistDir: null,
		// No-op spawn so the project-refresh path inside `POST /runs` doesn't
		// shell out to a real `git` against the tmpdir clone.
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

interface Harness {
	readonly db: WarrenDb;
	readonly repos: Repos;
	readonly pool: BurrowClientPool;
	readonly alpha: StubWorker;
	readonly beta: StubWorker;
	readonly handle: ServeHandle;
	readonly logger: Logger;
	readonly warnings: { obj: object; msg: string | undefined }[];
	readonly projectIds: ReadonlyMap<string, string>;
	readonly tmpdirs: readonly string[];
}

/**
 * Boot a warren server fronting a two-worker pool (alpha + beta), seed two
 * agents and two real-on-disk projects so the spawn flow's
 * `existsSync(localPath)` probe passes. Returns the open db handle, the
 * pool, both stub workers, and a captured warnings array so individual
 * tests can assert `worker_unreachable` lines.
 */
async function boot(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);

	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: {
			name: "refactor-bot",
			version: 1,
			sections: { system: "you are refactor-bot" },
			resolvedFrom: [],
			frontmatter: {},
		},
	});

	const aPath = await mkdtemp(join(tmpdir(), "warren-integ-A-"));
	const bPath = await mkdtemp(join(tmpdir(), "warren-integ-B-"));
	const projectA = await repos.projects.create({
		gitUrl: "https://github.com/x/a.git",
		localPath: aPath,
		defaultBranch: "main",
	});
	const projectB = await repos.projects.create({
		gitUrl: "https://github.com/x/b.git",
		localPath: bPath,
		defaultBranch: "main",
	});

	const token = "shared-secret";
	const clock = makeClock();
	const alpha = makeStubWorker("alpha", token, clock);
	const beta = makeStubWorker("beta", token, clock);

	const pool = new BurrowClientPool({ repos });
	await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/alpha.sock" });
	await repos.workers.upsert({ name: "beta", url: "unix:///tmp/beta.sock" });
	pool.register("alpha", alpha.client);
	pool.register("beta", beta.client);

	const warnings: { obj: object; msg: string | undefined }[] = [];
	const logger: Logger = {
		info() {},
		warn(obj: object, msg?: string) {
			warnings.push({ obj, msg });
		},
		error() {},
	};

	const handle = startServer(depsFor(repos, pool, logger), {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: NO_AUTH,
		logger,
	});

	const projectIds = new Map<string, string>([
		["A", projectA.id],
		["B", projectB.id],
	]);

	return {
		db,
		repos,
		pool,
		alpha,
		beta,
		handle,
		logger,
		warnings,
		projectIds,
		tmpdirs: [aPath, bPath],
	};
}

async function teardown(h: Harness): Promise<void> {
	await h.handle.stop();
	await h.db.close();
	await Promise.all(h.tmpdirs.map((p) => rm(p, { recursive: true, force: true })));
}

async function spawnViaHttp(
	h: Harness,
	projectKey: "A" | "B",
): Promise<{ runId: string; burrowId: string }> {
	const projectId = h.projectIds.get(projectKey);
	if (projectId === undefined) throw new Error(`unknown project key ${projectKey}`);
	const res = await fetch(`${tcpUrl(h.handle)}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			agent: "refactor-bot",
			project: projectId,
			prompt: `work on ${projectKey}`,
		}),
	});
	if (res.status !== 201) {
		throw new Error(
			`POST /runs for project ${projectKey} returned ${res.status}: ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { run: { id: string }; burrow: { id: string } };
	return { runId: body.run.id, burrowId: body.burrow.id };
}

function workerOf(h: Harness, burrowId: string): "alpha" | "beta" {
	if (h.alpha.state.burrows.has(burrowId)) return "alpha";
	if (h.beta.state.burrows.has(burrowId)) return "beta";
	throw new Error(`burrow ${burrowId} not found on either worker`);
}
// warren-1f56: SKIPPED — dispatch routes through the RuntimeProvider seam whose LocalProvider refuses a multi-worker pool; multi-worker placement retires with K8s (plan §5.C), still covered by pool/fanout/placement/workers/burrows unit suites.
describe.skip("two-worker integration (warren-a801)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await boot();
	});

	afterEach(async () => {
		await teardown(h);
	});

	test("project-affinity routes same-project runs to the same worker; new project takes least-loaded", async () => {
		// Pre-seed: a prior succeeded run for project A on beta. Without
		// affinity the alphabetical tiebreak would pick alpha; affinity must
		// override that. This is the cleanest way to prove placeForProject is
		// honouring `runs.mostRecentSucceededWithWorker` end-to-end.
		const seed = await h.repos.runs.create({
			agentName: "refactor-bot",
			projectId: h.projectIds.get("A") ?? "",
			prompt: "warm-up",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
			workerId: "beta",
		});
		await h.repos.runs.markRunning(seed.id, new Date("2026-05-12T00:00:00Z"));
		await h.repos.runs.finalize(seed.id, "succeeded", new Date("2026-05-12T01:00:00Z"));

		// A's first HTTP-dispatched run → beta (affinity).
		const first = await spawnViaHttp(h, "A");
		expect(workerOf(h, first.burrowId)).toBe("beta");
		expect((await h.repos.runs.require(first.runId)).workerId).toBe("beta");

		// Finalize the run so it stops counting as load; affinity for A
		// remains beta because that's the most recent succeeded run.
		await h.repos.runs.markRunning(first.runId);
		await h.repos.runs.finalize(first.runId, "succeeded");

		// A's second HTTP-dispatched run → beta again (affinity holds).
		const second = await spawnViaHttp(h, "A");
		expect(workerOf(h, second.burrowId)).toBe("beta");
		expect((await h.repos.runs.require(second.runId)).workerId).toBe("beta");

		// Leave A's second run in-flight (load=1 on beta), then spawn for
		// project B. B has no affinity → least-loaded healthy wins. Alpha
		// has zero in-flight; beta has one → alpha wins.
		const third = await spawnViaHttp(h, "B");
		expect(workerOf(h, third.burrowId)).toBe("alpha");
		expect((await h.repos.runs.require(third.runId)).workerId).toBe("alpha");

		// `burrows.worker_id` is the source of truth for sticky-by-burrow;
		// it must match the worker that physically holds the sandbox.
		expect((await h.repos.burrows.require(first.burrowId)).workerId).toBe("beta");
		expect((await h.repos.burrows.require(second.burrowId)).workerId).toBe("beta");
		expect((await h.repos.burrows.require(third.burrowId)).workerId).toBe("alpha");
	});

	test("drain on the affinity worker forwards /admin/drain and the next dispatch falls through to the other worker", async () => {
		// Land an A-run on alpha first (no affinity, both load 0 →
		// alphabetical wins). Mark succeeded so alpha becomes A's affinity.
		const first = await spawnViaHttp(h, "A");
		expect(workerOf(h, first.burrowId)).toBe("alpha");
		await h.repos.runs.markRunning(first.runId);
		await h.repos.runs.finalize(first.runId, "succeeded");

		// Drain alpha through the admin API. The handler must forward
		// `/admin/drain` to alpha's burrow process with the shared bearer,
		// flip warren's row to `draining`, and leave beta untouched.
		const drainRes = await fetch(`${tcpUrl(h.handle)}/workers/alpha/drain`, { method: "POST" });
		expect(drainRes.status).toBe(200);
		expect(await drainRes.json()).toEqual({ name: "alpha", state: "draining", drain: true });
		expect((await h.repos.workers.require("alpha")).state).toBe("draining");
		expect((await h.repos.workers.require("beta")).state).toBe("healthy");
		const drainCall = h.alpha.state.calls.find((c) => c.path === "/admin/drain");
		expect(drainCall).toBeDefined();
		expect(drainCall?.method).toBe("POST");
		expect(drainCall?.body).toEqual({ drain: true });
		expect(drainCall?.auth).toBe("Bearer shared-secret");
		expect(h.beta.state.calls.some((c) => c.path === "/admin/drain")).toBe(false);

		// The next A-run would prefer alpha by affinity, but alpha is
		// draining → placement falls through to least-loaded healthy →
		// beta is now the only healthy worker.
		const second = await spawnViaHttp(h, "A");
		expect(workerOf(h, second.burrowId)).toBe("beta");
		expect((await h.repos.runs.require(second.runId)).workerId).toBe("beta");

		// Sticky-by-burrow holds for the burrow already pinned to alpha:
		// `GET /burrows/:id` still routes to alpha even though it is
		// draining (orphaned runs continue to terminal state).
		const stickyRes = await fetch(`${tcpUrl(h.handle)}/burrows/${first.burrowId}`);
		expect(stickyRes.status).toBe(200);
		const stickyBody = (await stickyRes.json()) as { id: string };
		expect(stickyBody.id).toBe(first.burrowId);
		expect(
			h.alpha.state.calls.some(
				(c) => c.method === "GET" && c.path === `/burrows/${first.burrowId}`,
			),
		).toBe(true);
	});

	test("fan-out reads union both workers' burrows sorted by createdAt; killing one surfaces workerErrors + worker_unreachable", async () => {
		// Spawn three runs so each worker has rows to contribute. A → alpha
		// (alphabetical), A again still alpha (alpha has succeeded run as
		// affinity after we finalize), B → beta (alpha gets the in-flight
		// load from second A run → beta wins least-loaded).
		const a1 = await spawnViaHttp(h, "A");
		expect(workerOf(h, a1.burrowId)).toBe("alpha");
		await h.repos.runs.markRunning(a1.runId);
		await h.repos.runs.finalize(a1.runId, "succeeded");

		// Leave a2 in-flight so beta wins least-loaded for the next dispatch
		// to project B; otherwise both workers tie on load and alphabetical
		// tiebreak would route B to alpha as well.
		const a2 = await spawnViaHttp(h, "A");
		expect(workerOf(h, a2.burrowId)).toBe("alpha");

		const b1 = await spawnViaHttp(h, "B");
		expect(workerOf(h, b1.burrowId)).toBe("beta");

		// Healthy fan-out: union, ordered by createdAt asc (stub stamps
		// monotonically increasing minutes per call, so alpha's two come
		// first and beta's one is last).
		const listRes = await fetch(`${tcpUrl(h.handle)}/burrows`);
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as {
			burrows: { id: string }[];
			workerErrors: { worker: string; message: string }[];
		};
		expect(listBody.burrows.map((b) => b.id)).toEqual([a1.burrowId, a2.burrowId, b1.burrowId]);
		expect(listBody.workerErrors).toEqual([]);

		// Kill beta — simulate a worker mid-list going unreachable. Fan-out
		// must return alpha's rows and surface beta in `workerErrors`; the
		// logger captures a structured `worker_unreachable` line so
		// operators can grep per-worker drop-outs.
		h.beta.state.killed = true;
		const killedRes = await fetch(`${tcpUrl(h.handle)}/burrows`);
		expect(killedRes.status).toBe(200);
		const killedBody = (await killedRes.json()) as {
			burrows: { id: string }[];
			workerErrors: { worker: string; message: string }[];
		};
		expect(killedBody.burrows.map((b) => b.id)).toEqual([a1.burrowId, a2.burrowId]);
		expect(killedBody.workerErrors).toHaveLength(1);
		expect(killedBody.workerErrors[0]?.worker).toBe("beta");

		const warn = h.warnings.find((w) => w.msg === "worker_unreachable");
		expect(warn).toBeDefined();
		expect(warn?.obj).toMatchObject({ workerName: "beta", op: "burrows.list" });

		// Sticky-by-burrow flips to a structured error once beta is
		// flagged `unreachable` in warren's `workers` table (the probe
		// loop would normally do this; the test mutates state directly so
		// the failure path is deterministic). `GET /burrows/:id` for a
		// beta-pinned burrow MUST NOT silently re-place onto alpha.
		await h.repos.workers.setState("beta", "unreachable");
		const stickyRes = await fetch(`${tcpUrl(h.handle)}/burrows/${b1.burrowId}`);
		const stickyBody = (await stickyRes.json()) as { error: { code: string } };
		expect(stickyBody.error.code).toBe("sticky_worker_unreachable");
	});
});
