import type { Burrow, Message as BurrowMessage, Run as BurrowRun } from "@os-eco/burrow-cli";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { LocalProvider } from "../../runtime/local/provider.ts";
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
 * Historical single-worker pool wrapper (warren-39c3). Placement + the
 * workers/burrows tables were retired (warren-76c5 / warren-3743), so this is
 * now a pass-through kept for call-site stability; the `_repos` param is
 * vestigial.
 */
export async function makePool(
	_repos: Repos,
	client: BurrowClient,
	_workerName = "local",
): Promise<BurrowClient> {
	return client;
}

/**
 * Wrap a stub `BurrowClient` in a `LocalProvider` for the provider-only spawn
 * seam (warren-c42c). `spawnRun` no longer takes a `burrowClient` — it
 * dispatches through `runtimeProvider.create()` — so spawn tests build the
 * burrow-backed provider explicitly here. Behavior is identical to the old
 * dispatch fallback (which resolved a `LocalProvider` over the same client),
 * so the stubbed burrow HTTP surface exercises exactly the same code path.
 */
export function makeProvider(client: BurrowClient): RuntimeProvider {
	return new LocalProvider({ burrowClient: () => client });
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

/** A partial burrow event envelope for the NDJSON stub streams (seq defaulted). */
export interface StubEventInput {
	seq: number;
	kind?: string;
	stream?: string;
	payload?: unknown;
	ts?: string;
	runId?: string | null;
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
	/**
	 * `POST /runs/:id/cancel` (graceful cancel — the cancel source). Provide
	 * `cancelRun` to shape the returned post-cancel run row; `cancelStatus`
	 * overrides the response status and `cancelBody` the whole body (error paths).
	 */
	cancelRun?: Partial<BurrowRun>;
	cancelStatus?: number;
	cancelBody?: unknown;
	/**
	 * `POST /burrows/:id/inbox` (inbox send — the sendMessage source). Provide
	 * `inboxSend` to shape the returned message row; `inboxSendStatus` overrides
	 * the response status and `inboxSendBody` the whole body (for error paths).
	 */
	inboxSend?: Partial<BurrowMessage>;
	inboxSendStatus?: number;
	inboxSendBody?: unknown;
	/**
	 * `GET /runs/:id` (status). Provide `runGet` to route it; omitted leaves the
	 * route unmatched → 404 (so `runs.tryGet` returns null, i.e. exists:false).
	 * `runGetStatus` overrides the response status (e.g. 404, 500).
	 */
	runGet?: Partial<BurrowRun>;
	runGetStatus?: number;
	/** NDJSON events yielded by `GET /runs/:id/stream` (streamEvents source). */
	streamEvents?: StubEventInput[];
	/** NDJSON events yielded by `GET /burrows/:id/events` (status cursor replay). */
	replayEvents?: StubEventInput[];
}

export interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
	/**
	 * The request URL's raw query string (e.g. `?archive=true`), for query-param
	 * assertions. Omitted when the URL carried no query, so existing exact
	 * `toEqual` call-match assertions stay unaffected.
	 */
	search?: string;
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

function defaultBurrowMessage(overrides: Partial<BurrowMessage>): BurrowMessage {
	return {
		id: "msg_aaaaaaaaaaaa",
		burrowId: "bur_aaaaaaaaaaaa",
		fromActor: "operator",
		body: "focus on the failing test",
		priority: "normal",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date("2026-05-08T12:00:10Z"),
		deliveredAt: null,
		...overrides,
	};
}

function routeBurrowFetch(plan: BurrowFetchPlan, method: string, path: string): Response | null {
	return routeWriteFetch(plan, method, path) ?? routeReadFetch(plan, method, path);
}

/** The dispatch/provision/teardown mutations (create.test.ts). */
function routeWriteFetch(plan: BurrowFetchPlan, method: string, path: string): Response | null {
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
	return routeRunCancel(plan, method, path) ?? routeInboxSend(plan, method, path);
}

/** `POST /runs/:id/cancel` — the cancel source (cancel.test.ts). */
function routeRunCancel(plan: BurrowFetchPlan, method: string, path: string): Response | null {
	if (method === "POST" && /^\/runs\/[^/]+\/cancel$/.test(path)) {
		return jsonResponse(
			plan.cancelStatus ?? 200,
			plan.cancelBody ?? serializeRun(defaultBurrowRun({ run: plan.cancelRun })),
		);
	}
	return null;
}

/** `POST /burrows/:id/inbox` — the sendMessage source (send-message.test.ts). */
function routeInboxSend(plan: BurrowFetchPlan, method: string, path: string): Response | null {
	if (method === "POST" && /^\/burrows\/[^/]+\/inbox$/.test(path)) {
		return jsonResponse(
			plan.inboxSendStatus ?? 201,
			plan.inboxSendBody ?? serializeMessage(defaultBurrowMessage(plan.inboxSend ?? {})),
		);
	}
	return null;
}

/** The read surfaces streamEvents/status wrap (stream.test.ts / status.test.ts). */
function routeReadFetch(plan: BurrowFetchPlan, method: string, path: string): Response | null {
	if (method !== "GET") return null;
	// `/runs/:id/stream` MUST be matched before `/runs/:id` (prefix overlap).
	if (/^\/runs\/[^/]+\/stream$/.test(path)) return ndjsonResponse(plan.streamEvents ?? []);
	if (/^\/burrows\/[^/]+\/events$/.test(path)) return ndjsonResponse(plan.replayEvents ?? []);
	if (/^\/runs\/[^/]+$/.test(path)) return routeRunGet(plan);
	return null;
}

/** `GET /runs/:id` — omitted from the plan leaves it unmatched (→ 404). */
function routeRunGet(plan: BurrowFetchPlan): Response | null {
	if (plan.runGet === undefined && plan.runGetStatus === undefined) return null;
	const status = plan.runGetStatus ?? 200;
	if (status !== 200) {
		return jsonResponse(status, { error: { code: "not_found", message: "run gone" } });
	}
	return jsonResponse(status, serializeRun(defaultBurrowRun({ run: plan.runGet })));
}

/** Build an NDJSON `Response` of burrow event envelopes for the stub streams. */
export function ndjsonResponse(events: StubEventInput[]): Response {
	const body = events.map((e) => JSON.stringify(toEnvelope(e))).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

/** Shape a partial stub event into burrow's wire `EventEnvelope`. */
function toEnvelope(e: StubEventInput): Record<string, unknown> {
	return {
		type: "event",
		ts: e.ts ?? "2026-05-08T12:00:05.000Z",
		burrowId: "bur_aaaaaaaaaaaa",
		runId: e.runId === undefined ? "run_zzzzzzzzzzzz" : e.runId,
		seq: e.seq,
		kind: e.kind ?? "log",
		stream: e.stream ?? "stdout",
		payload: e.payload ?? {},
	};
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
		calls.push({ method, path, body, ...(url.search !== "" ? { search: url.search } : {}) });
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

function serializeMessage(m: BurrowMessage): unknown {
	return {
		...m,
		createdAt: m.createdAt.toISOString(),
		deliveredAt: m.deliveredAt?.toISOString() ?? null,
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
