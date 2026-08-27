/**
 * Deterministic in-process fake Warren server (warren-a732).
 *
 * Serves the exact documented surface the V0 client consumes —
 * `GET /whoami`, `POST /runs`, `GET /runs/:id` — with warren's documented
 * envelopes (`{run}`, `{error:{code,message}}`). It records every request
 * (method, path, headers, parsed body) so tests can assert exact header
 * propagation, models accepted-response-loss (the request was processed but
 * the client never sees the response), and models restart (the in-memory
 * idempotency store is wiped while the runs table survives).
 *
 * It exposes no production shortcut: the client under test talks to it only
 * through the same `fetch` interface it would use against real warren.
 */
import type { IdGenerator } from "./clock.ts";
import { SequentialIdGenerator } from "./clock.ts";
import type { FetchLike } from "./warren-client.ts";

/** One recorded request, exactly as the fake received it. */
export interface RecordedRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}

/** Mutable per-run state the tests advance through the lifecycle. */
export interface FakeRunRow {
	id: string;
	agentName: string;
	projectId: string;
	prompt: string;
	provider: string | null;
	model: string | null;
	maxCostUsd: number | null;
	state: string;
	failureReason: string | null;
	ref: string | null;
	targetBranch: string | null;
	/** Composed workspace branch frozen at dispatch (warren-5255). */
	branch: string | null;
	costUsd: number | null;
}

export interface FakeWarrenOptions {
	/** The bearer credential the fake accepts. */
	token: string;
	idGenerator?: IdGenerator;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function errorResponse(status: number, code: string, message: string): Response {
	return jsonResponse(status, { error: { code, message } });
}

/** Normalize one inbound request into the recorded shape. */
function recordRequest(
	url: string,
	init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
): RecordedRequest {
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(init.headers)) {
		headers[k.toLowerCase()] = v;
	}
	let body: unknown;
	if (init.body !== undefined) {
		try {
			body = JSON.parse(init.body);
		} catch {
			body = init.body;
		}
	}
	return { method: init.method, path: new URL(url).pathname, headers, body };
}

/** Required dispatch body fields, validated the way warren's handler does. */
function readDispatchFields(
	body: unknown,
): Pick<FakeRunRow, "agentName" | "projectId" | "prompt" | "provider" | "model" | "maxCostUsd"> {
	if (typeof body !== "object" || body === null) {
		throw new Error("fake warren: dispatch body must be an object");
	}
	const b = body as Record<string, unknown>;
	const requireString = (field: string): string => {
		const value = b[field];
		if (typeof value !== "string" || value === "") {
			throw new Error(`fake warren: dispatch requires a string ${field}`);
		}
		return value;
	};
	return {
		agentName: requireString("agent"),
		projectId: requireString("project"),
		prompt: requireString("prompt"),
		provider: typeof b.providerOverride === "string" ? b.providerOverride : null,
		model: typeof b.modelOverride === "string" ? b.modelOverride : null,
		maxCostUsd: typeof b.maxCostUsd === "number" ? b.maxCostUsd : null,
	};
}

/**
 * The fake warren. Hand the client `fake.fetch` as its `fetchFn`; nothing
 * else about the client changes between tests and production.
 */
export class FakeWarrenServer {
	private readonly token: string;
	private readonly idGenerator: IdGenerator;
	private readonly runs = new Map<string, FakeRunRow>();
	/** In-memory idempotency store, exactly as non-durable as warren's. */
	private readonly idempotency = new Map<string, string>();
	private readonly requests: RecordedRequest[] = [];

	private pendingDrops = 0;
	private rateLimitedReadsRemaining = 0;
	private rateLimitRetryAfterSec: number | null = null;
	private nextRawResponse: Response | null = null;
	private getRunReads = 0;
	private getRunReadHook: ((id: string, readCount: number) => void) | null = null;

	constructor(options: FakeWarrenOptions) {
		this.token = options.token;
		this.idGenerator = options.idGenerator ?? new SequentialIdGenerator();
	}

	/** The fetch-like entrypoint the client under test is wired to. */
	readonly fetch: FetchLike = async (url, init) => {
		const req = recordRequest(url, init);
		this.requests.push(req);
		if (this.nextRawResponse !== null) {
			const raw = this.nextRawResponse;
			this.nextRawResponse = null;
			return raw;
		}
		if (req.headers.authorization !== `Bearer ${this.token}`) {
			return errorResponse(401, "unauthorized", "missing or invalid bearer credential");
		}
		if (this.pendingDrops > 0) {
			this.pendingDrops -= 1;
			// The request was accepted and processed; only the response is lost.
			if (req.method === "POST" && req.path === "/runs") {
				this.acceptDispatch(req.body, req.headers["idempotency-key"] ?? "");
			}
			throw new Error("simulated connection reset after the request was accepted");
		}
		return this.route(req);
	};

	/** Route one authenticated, non-dropped request. */
	private route(req: RecordedRequest): Response {
		if (req.method === "GET" && this.rateLimitedReadsRemaining > 0) {
			this.rateLimitedReadsRemaining -= 1;
			return this.rateLimitResponse();
		}
		if (req.method === "GET" && req.path === "/whoami") {
			return jsonResponse(200, { identity: "operator", capabilities: ["readPublic"] });
		}
		if (req.method === "POST" && req.path === "/runs") {
			const run = this.acceptDispatch(req.body, req.headers["idempotency-key"] ?? "");
			return jsonResponse(201, {
				run,
				sandbox: { id: `sbx-${run.id}`, workspacePath: `/ws/${run.id}` },
			});
		}
		if (req.method === "GET") {
			const runResponse = this.runDetailResponse(req.path);
			if (runResponse !== undefined) {
				return runResponse;
			}
		}
		return errorResponse(404, "not_found", `no such route: ${req.method} ${req.path}`);
	}

	private rateLimitResponse(): Response {
		const headers: Record<string, string> = {};
		if (this.rateLimitRetryAfterSec !== null) {
			headers["Retry-After"] = String(this.rateLimitRetryAfterSec);
		}
		return jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }, headers);
	}

	/** `GET /runs/:id` response, or undefined when the path is not that route. */
	private runDetailResponse(path: string): Response | undefined {
		const runMatch = /^\/runs\/([^/]+)$/.exec(path);
		if (runMatch === null) {
			return undefined;
		}
		const id = decodeURIComponent(runMatch[1] ?? "");
		this.getRunReads += 1;
		// The hook runs BEFORE the row is read, so a test can mutate the run
		// between two reads — the live interleaving where a run settles while
		// a tick is still in flight (warren-968d).
		this.getRunReadHook?.(id, this.getRunReads);
		const run = this.runs.get(id);
		if (run === undefined) {
			return errorResponse(404, "not_found", "run not found");
		}
		return jsonResponse(200, { run });
	}

	/** Recorded requests, oldest first. */
	recordedRequests(): ReadonlyArray<Readonly<RecordedRequest>> {
		return this.requests;
	}

	getRunRow(id: string): FakeRunRow | undefined {
		return this.runs.get(id);
	}

	createdRunCount(): number {
		return this.runs.size;
	}

	/** Advance a run's lifecycle; also stamps cost on terminal states. */
	setRunState(
		id: string,
		patch: Partial<
			Pick<FakeRunRow, "state" | "failureReason" | "costUsd" | "ref" | "targetBranch" | "branch">
		>,
	): void {
		const run = this.runs.get(id);
		if (run === undefined) {
			throw new Error(`fake warren has no run ${id}`);
		}
		Object.assign(run, patch);
	}

	/**
	 * Accepted-response-loss: the next N requests are processed by the server
	 * but the transport throws, so the client cannot know the outcome.
	 */
	dropNextResponses(count: number): void {
		this.pendingDrops = count;
	}

	/** Serve 429 (optionally with Retry-After) on the next N safe reads. */
	rateLimitReads(count: number, retryAfterSec: number | null): void {
		this.rateLimitedReadsRemaining = count;
		this.rateLimitRetryAfterSec = retryAfterSec;
	}

	/** Serve one raw response (malformed-envelope scenarios). */
	respondOnceWith(raw: Response): void {
		this.nextRawResponse = raw;
	}

	/** Install a hook fired before each `GET /runs/:id` response is built. */
	onGetRunRead(hook: (id: string, readCount: number) => void): void {
		this.getRunReadHook = hook;
	}

	/** Simulate a warren restart: runs survive, the idempotency store does not. */
	restart(): void {
		this.idempotency.clear();
	}

	private acceptDispatch(body: unknown, idempotencyKey: string): FakeRunRow {
		const fields = readDispatchFields(body);
		if (idempotencyKey !== "") {
			const existing = this.dedupeHit(idempotencyKey);
			if (existing !== undefined) {
				return existing;
			}
		}
		const id = this.idGenerator.newId();
		const run: FakeRunRow = {
			id,
			state: "queued",
			failureReason: null,
			ref: null,
			targetBranch: null,
			branch: null,
			costUsd: null,
			...fields,
		};
		this.runs.set(id, run);
		if (idempotencyKey !== "") {
			this.idempotency.set(idempotencyKey, id);
		}
		return run;
	}

	/** The run an idempotency-key replay should return, if its store row lives. */
	private dedupeHit(idempotencyKey: string): FakeRunRow | undefined {
		const existingId = this.idempotency.get(idempotencyKey);
		return existingId !== undefined ? this.runs.get(existingId) : undefined;
	}
}
