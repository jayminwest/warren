import type { Burrow, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import type { AppendPlotRunDispatchedInput, SpawnPlotAppender } from "./types.ts";

/**
 * Open an in-memory warren db with a default `refactor-bot` agent and
 * one project (`prj_xxxxxxxxxxxx`) seeded. Used by every spawn test
 * file — keeps the per-file beforeEach short.
 */
export async function setupRepos(): Promise<{ db: WarrenDb; repos: Repos }> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: makeAgentJson() });
	await repos.projects.create({
		id: "prj_xxxxxxxxxxxx",
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { db, repos };
}

export function makeAppender(
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
export async function makePool(
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
export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

export function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export interface BurrowFetchPlan {
	burrow?: Partial<Burrow>;
	run?: Partial<BurrowRun>;
	burrowsUpStatus?: number;
	burrowsUpBody?: unknown;
	runsCreateStatus?: number;
	runsCreateBody?: unknown;
	destroyStatus?: number;
	destroyBody?: unknown;
}

export interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

function defaultBurrow(plan: BurrowFetchPlan): Burrow {
	return {
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
}

function defaultBurrowRun(plan: BurrowFetchPlan): BurrowRun {
	return {
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
}

function routeBurrowFetch(plan: BurrowFetchPlan, method: string, path: string): Response | null {
	if (method === "POST" && path === "/burrows") {
		return jsonResponse(
			plan.burrowsUpStatus ?? 201,
			plan.burrowsUpBody ?? serializeBurrow(defaultBurrow(plan)),
		);
	}
	if (method === "POST" && /^\/burrows\/[^/]+\/runs$/.test(path)) {
		return jsonResponse(
			plan.runsCreateStatus ?? 201,
			plan.runsCreateBody ?? serializeRun(defaultBurrowRun(plan)),
		);
	}
	if (method === "DELETE" && /^\/burrows\/[^/]+$/.test(path)) {
		return jsonResponse(
			plan.destroyStatus ?? 200,
			plan.destroyBody ?? { burrowId: "bur_aaaaaaaaaaaa", archived: false },
		);
	}
	return null;
}

export function makeBurrowClient(plan: BurrowFetchPlan = {}): {
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
		const routed = routeBurrowFetch(plan, method, path);
		if (routed !== null) return routed;
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
export function readCanopyFrontmatter(calls: readonly RecordedCall[]): Record<string, unknown> {
	const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
	const seed = (
		up?.body as { seed?: { files?: ReadonlyArray<{ path: string; contents: string }> } }
	)?.seed;
	const canopy = seed?.files?.find((f) => f.path === ".canopy/agent.json");
	if (canopy === undefined) throw new Error(".canopy/agent.json missing from seed payload");
	const parsed = JSON.parse(canopy.contents) as { frontmatter?: Record<string, unknown> };
	return parsed.frontmatter ?? {};
}

export function makeAgentJson(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
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
