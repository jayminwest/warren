import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { SpawnFn as ProjectSpawnFn, SpawnResult } from "../projects/clone.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import {
	type AppendPlotRunDispatchedInput,
	composeDispatchPrompt,
	DEFAULT_DISPATCHER_HANDLE,
	type SpawnPlotAppender,
	spawnRun,
} from "./spawn.ts";

function makeAppender(
	opts: { calls?: AppendPlotRunDispatchedInput[]; throws?: Error } = {},
): SpawnPlotAppender {
	const calls = opts.calls ?? [];
	return {
		async appendRunDispatched(input) {
			calls.push(input);
			if (opts.throws) throw opts.throws;
		},
	};
}

/**
 * Wrap a stubbed `BurrowClient` in a single-worker `BurrowClientPool`
 * so the spawn flow can resolve placement (warren-39c3). Upserts a
 * synthetic `local` worker row so `placeForProject` has a healthy
 * candidate to pick.
 */
async function makePool(
	repos: Repos,
	client: BurrowClient,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client);
	return pool;
}

// `typeof fetch` requires a `preconnect` method we don't exercise in tests; cast
// each stub so callers can pass a plain async function.
function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface BurrowFetchPlan {
	burrow?: Partial<Burrow>;
	run?: Partial<BurrowRun>;
	burrowsUpStatus?: number;
	burrowsUpBody?: unknown;
	runsCreateStatus?: number;
	runsCreateBody?: unknown;
	destroyStatus?: number;
	destroyBody?: unknown;
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(plan: BurrowFetchPlan = {}): {
	client: BurrowClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		if (method === "POST" && path === "/burrows") {
			const burrow: Burrow = {
				id: "bur_aaaaaaaaaaaa",
				parentId: null,
				kind: "task",
				name: null,
				projectRoot: "/data/projects/x/y",
				workspacePath: "/data/burrow/workspaces/bur_aaaaaaaaaaaa",
				branch: "warren/run/abc",
				provider: "local",
				providerStateJson: null,
				profileJson: {},
				state: "active",
				createdAt: new Date("2026-05-08T12:00:00Z"),
				updatedAt: new Date("2026-05-08T12:00:00Z"),
				destroyedAt: null,
				...plan.burrow,
			};
			return jsonResponse(
				plan.burrowsUpStatus ?? 201,
				plan.burrowsUpBody ?? serializeBurrow(burrow),
			);
		}
		if (method === "POST" && path.match(/^\/burrows\/[^/]+\/runs$/)) {
			const run: BurrowRun = {
				id: "run_zzzzzzzzzzzz",
				burrowId: "bur_aaaaaaaaaaaa",
				agentId: "refactor-bot",
				prompt: "fix the test",
				resumeOfRunId: null,
				state: "queued",
				exitCode: null,
				errorMessage: null,
				metadataJson: null,
				queuedAt: new Date("2026-05-08T12:00:01Z"),
				startedAt: null,
				completedAt: null,
				...plan.run,
			};
			return jsonResponse(plan.runsCreateStatus ?? 201, plan.runsCreateBody ?? serializeRun(run));
		}
		if (method === "DELETE" && path.match(/^\/burrows\/[^/]+$/)) {
			return jsonResponse(
				plan.destroyStatus ?? 200,
				plan.destroyBody ?? { burrowId: "bur_aaaaaaaaaaaa", archived: false },
			);
		}
		return jsonResponse(404, {
			error: { code: "not_found", message: `unmatched ${method} ${path}` },
		});
	});
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
	return { client, calls };
}

function serializeBurrow(b: Burrow): unknown {
	return {
		...b,
		createdAt: b.createdAt.toISOString(),
		updatedAt: b.updatedAt.toISOString(),
		destroyedAt: b.destroyedAt?.toISOString() ?? null,
	};
}

function serializeRun(r: BurrowRun): unknown {
	return {
		...r,
		queuedAt: r.queuedAt.toISOString(),
		startedAt: r.startedAt?.toISOString() ?? null,
		completedAt: r.completedAt?.toISOString() ?? null,
	};
}

/**
 * Pull `.canopy/agent.json` out of the seed payload that rode on POST /burrows
 * and return its `frontmatter`. The seed payload travels as part of
 * `burrows.up({ seed: { files } })`, so the canopy envelope is recoverable
 * from the recorded request body without a separate seam.
 */
function readCanopyFrontmatter(calls: readonly RecordedCall[]): Record<string, unknown> {
	const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
	const seed = (
		up?.body as { seed?: { files?: ReadonlyArray<{ path: string; contents: string }> } }
	)?.seed;
	const canopy = seed?.files?.find((f) => f.path === ".canopy/agent.json");
	if (canopy === undefined) throw new Error(".canopy/agent.json missing from seed payload");
	const parsed = JSON.parse(canopy.contents) as { frontmatter?: Record<string, unknown> };
	return parsed.frontmatter ?? {};
}

function makeAgentJson(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 1,
		sections: {
			system: "be a refactor agent",
			...(overrides.sections ?? {}),
		},
		resolvedFrom: [],
		frontmatter: {},
		...overrides,
	};
}

describe("spawnRun", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: makeAgentJson() });
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("rejects an empty prompt before touching db or burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "   ",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("throws NotFoundError when the agent is not registered", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "no-such-agent",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the project does not exist", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_doesnotexist",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("rejects plotId when project.hasPlot is false (warren-a8c3)", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				plotId: "plot-2047abc1",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("persists plotId on the runs row when project.hasPlot is true (warren-a8c3)", async () => {
		// No public mutator on ProjectsRepo for has_plot yet — refreshProjectClone
		// is the production write path (warren-4e20). Flip the column directly so
		// the test isolates the spawn-side surface; the integration end-to-end
		// is covered by warren-4e06's acceptance scenario.
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");

		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
		});
		expect(result.run.plotId).toBe("plot-2047abc1");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.plotId).toBe("plot-2047abc1");
	});

	test("injects PLOT_ID + PLOT_ACTOR onto the burrow up call when plotId is set (warren-e26f)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");

		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
		});

		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect(up).toBeDefined();
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env).toEqual({
			PLOT_ID: "plot-2047abc1",
			PLOT_ACTOR: `agent:refactor-bot:${result.run.id}`,
		});
	});

	test("omits env from the burrow up call when no plotId is set (warren-e26f)", async () => {
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
		});

		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect(up).toBeDefined();
		expect((up?.body as { env?: unknown }).env).toBeUndefined();
	});

	test("appends run_dispatched to the originating Plot after spawn (warren-e848)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: { model: "claude-opus-4-7" } }),
		});
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			dispatcherHandle: "alice",
			plotAppender: makeAppender({ calls: appendCalls }),
		});

		expect(appendCalls).toHaveLength(1);
		const call = appendCalls[0];
		if (!call) throw new Error("appender not called");
		expect(call.plotDir).toBe("/data/projects/x/y/.plot");
		expect(call.plotId).toBe("plot-2047abc1");
		expect(call.handle).toBe("alice");
		expect(call.runId).toBe(result.run.id);
		expect(call.agentName).toBe("refactor-bot");
		expect(call.model).toBe("claude-opus-4-7");
		expect(call.projectId).toBe("prj_xxxxxxxxxxxx");
		expect(await repos.events.maxSeqForRun(result.run.id)).toBeNull();
	});

	test("skips run_dispatched append when no plotId is set (warren-e848)", async () => {
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls).toHaveLength(0);
	});

	test("falls back to DEFAULT_DISPATCHER_HANDLE when handle is malformed (warren-e848)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			dispatcherHandle: "@bad/handle",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.handle).toBe(DEFAULT_DISPATCHER_HANDLE);
	});

	test("uses DEFAULT_DISPATCHER_HANDLE when dispatcherHandle is omitted (warren-e848)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.handle).toBe(DEFAULT_DISPATCHER_HANDLE);
	});

	test("records plot_run_dispatched_failed and does NOT roll back when the appender throws (warren-e848)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ throws: new Error("rebuild failed too") }),
		});
		// Spawn returned a non-cancelled run row, proving the failure didn't
		// roll the dispatch back.
		expect(result.run.state === "queued" || result.run.state === "running").toBe(true);
		const events = await repos.events.listByRun(result.run.id);
		const failure = events.find((e) => e.kind === "plot_run_dispatched_failed");
		expect(failure).toBeDefined();
		expect(failure?.stream).toBe("system");
		const payload = failure?.payloadJson as { plotId?: string; reason?: string };
		expect(payload?.plotId).toBe("plot-2047abc1");
		expect(payload?.reason).toContain("rebuild failed too");
	});

	test("passes model=null when the agent has no frontmatter.model (warren-e848)", async () => {
		db.raw.exec("UPDATE projects SET has_plot = 1 WHERE id = 'prj_xxxxxxxxxxxx'");
		const appendCalls: AppendPlotRunDispatchedInput[] = [];
		const { client } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			plotId: "plot-2047abc1",
			plotAppender: makeAppender({ calls: appendCalls }),
		});
		expect(appendCalls[0]?.model).toBeNull();
	});

	test("prefers the project-tier agent when one exists for the spawn's project (R-03 / warren-0a7e)", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			renderedJson: makeAgentJson({
				sections: { system: "project tier system" },
				frontmatter: { source: "project:prj_xxxxxxxxxxxx" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			sections: Record<string, string>;
			frontmatter: Record<string, unknown>;
		};
		expect(stored.sections.system).toBe("project tier system");
		expect(stored.frontmatter.source).toBe("project:prj_xxxxxxxxxxxx");
	});

	test("falls back to the global-tier agent when no project-tier row matches (R-03 / warren-0a7e)", async () => {
		// Only the global `refactor-bot` exists (seeded in beforeEach); no
		// project-tier row for `prj_xxxxxxxxxxxx`. The unrelated project-tier
		// row on a DIFFERENT project must not leak across.
		await repos.projects.create({
			id: "prj_otherrrrrrr",
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId: "prj_otherrrrrrr",
			renderedJson: makeAgentJson({
				sections: { system: "other project system" },
				frontmatter: { source: "project:prj_otherrrrrrr" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			sections: Record<string, string>;
			frontmatter: Record<string, unknown>;
		};
		expect(stored.sections.system).toBe("be a refactor agent");
		expect(stored.frontmatter.source).toBeUndefined();
	});

	test("end-to-end: creates the warren run, provisions+seeds the burrow atomically, dispatches", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
		});

		// Warren run row
		expect(isId("run", result.run.id)).toBe(true);
		expect(result.run.state).toBe("queued");
		expect(result.run.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.burrowRunId).toBe("run_zzzzzzzzzzzz");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// Frozen rendered agent JSON survives the round-trip
		const stored = reread.renderedAgentJson as { name: string; sections: Record<string, string> };
		expect(stored.name).toBe("refactor-bot");
		expect(stored.sections.system).toBe("be a refactor agent");

		// Two HTTP calls: provision-with-seed, then dispatch. The seed.files
		// payload rides on POST /burrows so provisioning + workspace drops are
		// atomic — burrow rolls back if any file is rejected (R-07).
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "be a refactor agent\n\n---\n\nfix the flaky test",
				metadata: { frontmatter: {} },
			},
		});

		// POST /burrows body: agents + seed.files payload (no half-seeded
		// workspace ever observable on warren's side).
		const upBody = calls[0]?.body as {
			projectRoot: string;
			originUrl: string;
			agents: readonly string[];
			seed?: { files: ReadonlyArray<{ path: string; contents: string }> };
		};
		expect(upBody.projectRoot).toBe("/data/projects/x/y");
		expect(upBody.originUrl).toBe("https://github.com/x/y.git");
		expect(upBody.agents).toEqual(["refactor-bot"]);
		const seededPaths = (upBody.seed?.files ?? []).map((f) => f.path);
		expect(seededPaths).toContain(".canopy/agent.json");

		// warren-39c3: placement persisted on both sides of the burrow → worker
		// mapping. runs.worker_id is the denormalized copy; burrows.worker_id is
		// the source of truth that cancel/steer/reap resolve through clientFor.
		expect(reread.workerId).toBe("local");
		const burrowRow = await repos.burrows.require("bur_aaaaaaaaaaaa");
		expect(burrowRow.workerId).toBe("local");
	});

	test("placement: writes worker_id under a non-default worker name (warren-39c3)", async () => {
		const { client } = makeBurrowClient();
		const pool = await makePool(repos, client, "alpha");
		const result = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		expect((await repos.runs.require(result.run.id)).workerId).toBe("alpha");
		expect((await repos.burrows.require(result.burrow.id)).workerId).toBe("alpha");
	});

	test("placement: raises NoEligibleWorkerError when no healthy worker exists (warren-39c3)", async () => {
		const { client } = makeBurrowClient();
		// Pool with a registered client but no `healthy` worker row — drives
		// placeForProject into NoEligibleWorkerError before any burrow call.
		const pool = new BurrowClientPool({ repos });
		pool.register("local", client);
		await expect(
			spawnRun({
				repos,
				burrowClientPool: pool,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toThrow(/no_eligible_worker|no healthy/);
		// No warren row created; placement happens before runs.create.
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("forwards burrow_config network and metadata onto the burrow calls", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({
				sections: {
					system: "s",
					burrow_config: `[sandbox]\nnetwork = "restricted"`,
				},
			}),
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			metadata: { runByOperator: "alice" },
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/burrows",
			body: {
				projectRoot: "/data/projects/x/y",
				originUrl: "https://github.com/x/y.git",
				network: "restricted",
				agents: ["refactor-bot"],
			},
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "s\n\n---\n\np",
				metadata: { runByOperator: "alice", frontmatter: {} },
			},
		});
	});

	test("dispatch uses frontmatter.runtime as the burrow runtime id when set (warren-ebca)", async () => {
		// Brainstorm/planner are canopy agents whose name (`brainstorm`)
		// is NOT a burrow runtime id; without `frontmatter.runtime`,
		// dispatchRun would send `"brainstorm"` and burrow would fail the
		// run with `agent 'brainstorm' is not registered`. The fix routes
		// the dispatch onto the declared runtime instead.
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: makeAgentJson({
				name: "brainstorm",
				sections: { system: "be a scout" },
				frontmatter: { source: "builtin", runtime: "claude-code" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "help me think",
		});
		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { agentId: string }).agentId).toBe("claude-code");
	});

	test("dispatch falls back to agent.name when frontmatter.runtime is unset (warren-ebca)", async () => {
		// claude-code / sapling / pi keep working: their name already
		// matches their burrow runtime id, so omitting `runtime` resolves
		// to `agent.name` via readRuntimeId().
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: {} }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect((dispatch?.body as { agentId: string }).agentId).toBe("refactor-bot");
	});

	test("forwards agent.frontmatter as burrow run metadata so piRuntime gets provider/model (warren-d34e)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-opus-4-7" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		expect(body.metadata.frontmatter.provider).toBe("anthropic");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
		expect(body.metadata.frontmatter.source).toBe("builtin");
	});

	test("dispatch metadata frontmatter reflects per-run + project-default overrides (warren-d34e)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		// Operator override wins for provider; project default wins for model.
		expect(body.metadata.frontmatter.provider).toBe("openai");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("rolls back: cancels the warren row when burrow rejects the seed payload (atomic rollback, R-07)", async () => {
		// A bad seed file makes burrow's `POST /burrows` reject before the
		// burrow ever materializes — the rollback is on burrow's side, so
		// warren never sees a burrow id and there's no DELETE to fire.
		const { client, calls } = makeBurrowClient({
			burrowsUpStatus: 422,
			burrowsUpBody: {
				error: {
					code: "validation_error",
					message: "seed file rejected: workspace path escapes root",
				},
			},
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		// Warren row still exists in cancelled state with no burrow attached.
		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
		expect(rows[0]?.burrowRunId).toBeNull();

		// Only POST /burrows fired; no DELETE (burrow rolled back on its side)
		// and no /runs dispatch.
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toEqual(["POST /burrows"]);
	});

	test("rolls back when burrow dispatch fails", async () => {
		const { client, calls } = makeBurrowClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(rows[0]?.burrowRunId).toBeNull();
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("DELETE /burrows/bur_aaaaaaaaaaaa");
	});

	test("propagates burrow transport failures and leaves no warren row attached to a burrow", async () => {
		const errFetch = stub(async () => {
			const e = new TypeError("fetch failed");
			(e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw e;
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: errFetch,
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(BurrowUnreachableError);

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
	});

	test("readCachedAgent: handles older cached envelopes (raw cn render output)", async () => {
		// Older registry refresh paths may have stored the raw envelope rather
		// than the parsed AgentDefinition. The spawn flow re-parses on read so
		// stale caches don't crash the flow.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				success: true,
				command: "render",
				name: "refactor-bot",
				version: 2,
				sections: [{ name: "system", body: "s" }],
			},
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = result.run.renderedAgentJson as { sections: Record<string, string> };
		expect(stored.sections.system).toBe("s");
	});

	test("rejects a corrupted cached agent JSON with RunSpawnError", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", version: 1, sections: { system: 42 } },
		});
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});

	test("refreshes the project clone before provisioning burrow when projectsConfig + projectSpawn are wired", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshCalled = true;
				refreshRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		expect(refreshCalled).toBe(true);
		expect(refreshRef).toBeUndefined(); // defaults to row's defaultBranch inside refreshProject
		// Burrow was provisioned with the project's localPath after refresh
		expect(calls[0]?.body).toMatchObject({ projectRoot: "/data/projects/x/y" });

		// HEAD sha was persisted onto the project row
		const persisted = await repos.projects.require("prj_xxxxxxxxxxxx");
		expect(persisted.lastHeadSha).toBe("feedface".repeat(5));
		expect(persisted.lastFetchedAt).not.toBeNull();
	});

	test("forwards an explicit ref override into refreshProjectFn", async () => {
		const { client } = makeBurrowClient();
		let receivedRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			ref: "feature/x",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				receivedRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "abcd".repeat(10),
				});
				return { project: updated, headSha: "abcd".repeat(10), ref: input.ref ?? "" };
			},
		});
		expect(receivedRef).toBe("feature/x");
	});

	test("aborts spawn when refresh fails — no warren row, no burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn: async () => {
					throw new Error("git fetch failed");
				},
			}),
		).rejects.toBeDefined();

		expect(await repos.runs.listAll()).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("folds providerOverride + modelOverride onto frontmatter before freeze and seed (warren-f8c0)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-sonnet-4-6" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			modelOverride: "gpt-4o",
		});

		// The seed payload shipped on POST /burrows carries the override-applied
		// agent envelope verbatim (buildSeedFiles materializes the resolved
		// frontmatter into `.canopy/agent.json`).
		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("openai");
		expect(seededFm.model).toBe("gpt-4o");
		// Original builtin frontmatter preserved
		expect(seededFm.source).toBe("builtin");

		// Frozen rendered_agent_json carries the overrides
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("gpt-4o");

		// Cached agent row is untouched — the override is per-run, not per-agent
		const reread = (await repos.agents.require("pi")).renderedJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(reread.frontmatter.provider).toBe("anthropic");
		expect(reread.frontmatter.model).toBe("claude-sonnet-4-6");
	});

	test("falls back to .warren/defaults.json provider/model when no per-run override (warren-618b)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("anthropic");
		expect(seededFm.model).toBe("claude-opus-4-7");
		expect(seededFm.source).toBe("builtin");
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("per-run override beats .warren/defaults.json beats agent frontmatter (warren-618b)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		// Operator override wins for provider; project default wins for model
		// since no per-run modelOverride was supplied.
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("leaves frontmatter alone when overrides are empty / whitespace (warren-f8c0)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "anthropic" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "  ",
			modelOverride: "",
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBeUndefined();
	});

	test("composes burrow branch as '<default-prefix>/<run.id>' when no override is set (warren-9993)", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`burrow/${result.run.id}`);
	});

	test("env-level runBranchPrefixDefault overrides the built-in 'burrow' default (warren-9993)", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			runBranchPrefixDefault: "warren",
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`warren/${result.run.id}`);
	});

	test("project default runBranchPrefix beats env-level fallback (warren-9993)", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			runBranchPrefixDefault: "warren",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { runBranchPrefix: "bot" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`bot/${result.run.id}`);
	});

	test("stamps {role,trigger,lastRunId,lastRunAt} on the seed when seedId + seedsCli are wired (pl-bb70 step 4)", async () => {
		const { client } = makeBurrowClient();
		const sdCalls: { cmd: readonly string[]; cwd: string }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd, opts) => {
			sdCalls.push({ cmd, cwd: opts.cwd });
			return { stdout: "{}", stderr: "", exitCode: 0 } satisfies SpawnResult;
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "/opt/sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		expect(sdCalls).toHaveLength(1);
		const call = sdCalls[0];
		if (call === undefined) throw new Error("expected one sd call");
		expect(call.cwd).toBe("/data/projects/x/y");
		expect(call.cmd[0]).toBe("/opt/sd");
		expect(call.cmd[1]).toBe("update");
		expect(call.cmd[2]).toBe("warren-abc");
		expect(call.cmd[3]).toBe("--extensions");
		expect(JSON.parse(call.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			trigger: "manual",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});

		// No system event — the write succeeded
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("seedId without seedsCli is a no-op extension write (legacy callers, CLI)", async () => {
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
		});
		expect(result.run.seedId).toBe("warren-abc");
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("seedsCli without seedId never shells out", async () => {
		const { client } = makeBurrowClient();
		let sdCalled = false;
		const seedsSpawn: ProjectSpawnFn = async () => {
			sdCalled = true;
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
		});
		expect(sdCalled).toBe(false);
	});

	test("emits seeds_extension_write_failed on a failing sd update without rolling back the run (acceptance #5)", async () => {
		const { client } = makeBurrowClient();
		const seedsSpawn: ProjectSpawnFn = async () => ({
			stdout: "",
			stderr: "seeds: no such issue warren-abc",
			exitCode: 1,
		});
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
		});

		// Run survived the extension-write failure — burrow row is attached,
		// state stayed queued.
		const reread = await repos.runs.require(result.run.id);
		expect(reread.state).toBe("queued");
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		// A single system event surfaces the lingering extension to the
		// operator without forcing them to tail logs.
		const events = await repos.events.listByRun(result.run.id);
		expect(events).toHaveLength(1);
		const evt = events[0];
		if (evt === undefined) throw new Error("expected one event");
		expect(evt.kind).toBe("seeds_extension_write_failed");
		expect(evt.stream).toBe("system");
		expect(evt.burrowEventSeq).toBe(1);
		const payload = evt.payloadJson as { seedId: string; reason: string };
		expect(payload.seedId).toBe("warren-abc");
		expect(payload.reason).toContain("sd update");
	});

	test("drops an unrecognized trigger string but still writes role/lastRunId/lastRunAt (handlers.ts:354 'manual-trigger')", async () => {
		const { client } = makeBurrowClient();
		const sdCalls: { cmd: readonly string[] }[] = [];
		const seedsSpawn: ProjectSpawnFn = async (cmd) => {
			sdCalls.push({ cmd });
			return { stdout: "{}", stderr: "", exitCode: 0 };
		};
		const fixedNow = new Date("2026-05-15T17:00:00.000Z");
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			seedId: "warren-abc",
			trigger: "manual-trigger",
			seedsCli: { sdBinary: "sd", spawn: seedsSpawn },
			now: () => fixedNow,
		});

		expect(sdCalls).toHaveLength(1);
		expect(JSON.parse(sdCalls[0]?.cmd[4] ?? "{}")).toEqual({
			role: "refactor-bot",
			lastRunId: result.run.id,
			lastRunAt: fixedNow.toISOString(),
		});
		expect(await repos.events.countByRun(result.run.id)).toBe(0);
	});

	test("skips refresh when projectsConfig is not wired (back-compat for tests)", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			refreshProjectFn: async () => {
				refreshCalled = true;
				return {
					project: await repos.projects.require("prj_xxxxxxxxxxxx"),
					headSha: "x",
					ref: "main",
				};
			},
		});
		expect(refreshCalled).toBe(false);
		// Project row's lastHeadSha stays null
		expect((await repos.projects.require("prj_xxxxxxxxxxxx")).lastHeadSha).toBeNull();
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("composeDispatchPrompt", () => {
	test("prepends the system body with a horizontal-rule delimiter", () => {
		expect(composeDispatchPrompt("be a refactor agent", "fix it")).toBe(
			"be a refactor agent\n\n---\n\nfix it",
		);
	});

	test("trims trailing whitespace on the system body before joining", () => {
		expect(composeDispatchPrompt("system\n\n\n", "task")).toBe("system\n\n---\n\ntask");
	});

	test("returns the user prompt verbatim when system is empty or whitespace", () => {
		expect(composeDispatchPrompt("", "task")).toBe("task");
		expect(composeDispatchPrompt("   \n\t", "task")).toBe("task");
		expect(composeDispatchPrompt(undefined, "task")).toBe("task");
	});
});
