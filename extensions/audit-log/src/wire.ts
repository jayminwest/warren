/**
 * Hand-derived wire types for warren's HTTP API.
 *
 * FRICTION §2: there is no published client artifact a third party can
 * depend on. These shapes are re-declared here from `docs/openapi.yaml`,
 * `docs/http-api.md`, and observed responses from a fake warren — drift is
 * caught by runtime validation at the parse boundary
 * ({@link WireDriftError}), never by a compiler.
 *
 * Third-party posture: parse only the fields the collector needs and
 * tolerate everything else. A run row carries dozens of columns; the
 * collector reads `id` and `state` and ignores the rest, so additive
 * server-side fields never break the extension.
 */

/** Closed run lifecycle vocabulary, mirroring warren's `RUN_STATES`. */
export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const;

/** True once a run can no longer change state. */
export function isTerminalRunState(state: RunState): boolean {
	return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The slice of a `GET /runs` row the collector reads. Every other field
 * is passed through untouched — additive server fields must never be a
 * breaking change for an observer.
 */
export interface RunListRow {
	readonly id: string;
	readonly state: RunState;
}

/** The `GET /runs` response envelope (paginated by `?limit`/`?offset`). */
export interface RunListPage {
	readonly runs: RunListRow[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
}

/**
 * One NDJSON line from `GET /runs/:id/events`. The envelope keys are the
 * server's allowlisted projection (`id`, `runId`, `seq`, `ts`, `kind`,
 * `stream`, `payload`); `payload` is free-form and kind-dependent.
 *
 * `seq` is warren's `sandboxEventSeq` — monotonic PER RUN, not globally.
 * FRICTION §1: there is no warren-wide sequence, so the collector keeps
 * one cursor per run.
 */
export interface RunEvent {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

/**
 * Raised at the parse boundary when a response no longer matches the
 * hand-derived contract — the only drift detection an out-of-core
 * extension gets (FRICTION §2).
 */
export class WireDriftError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(`warren wire drift: ${detail}`);
		this.name = "WireDriftError";
		this.detail = detail;
	}
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new WireDriftError(`${what} must be an object; got ${typeof value}`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string") {
		throw new WireDriftError(`${what} must be a string; got ${typeof value}`);
	}
	return value;
}

function asNumber(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new WireDriftError(`${what} must be a finite number; got ${typeof value}`);
	}
	return value;
}

/** Narrow one entry of the `runs` array, tolerating every other field. */
export function parseRunListRow(value: unknown): RunListRow {
	const row = asRecord(value, "runs[] entry");
	const id = asString(row.id, "runs[].id");
	const rawState = asString(row.state, `runs[${id}].state`);
	if (!(RUN_STATES as readonly string[]).includes(rawState)) {
		throw new WireDriftError(
			`runs[${id}].state '${rawState}' is outside the known vocabulary ${RUN_STATES.join("|")}`,
		);
	}
	return { id, state: rawState as RunState };
}

/** Narrow the whole `GET /runs` envelope. */
export function parseRunListPage(value: unknown): RunListPage {
	const body = asRecord(value, "GET /runs response");
	if (!Array.isArray(body.runs)) {
		throw new WireDriftError("GET /runs response .runs must be an array");
	}
	return {
		runs: body.runs.map(parseRunListRow),
		total: asNumber(body.total, "GET /runs .total"),
		limit: asNumber(body.limit, "GET /runs .limit"),
		offset: asNumber(body.offset, "GET /runs .offset"),
	};
}

/** Narrow one NDJSON event line from `GET /runs/:id/events`. */
export function parseRunEvent(value: unknown): RunEvent {
	const row = asRecord(value, "event line");
	const stream = row.stream;
	if (stream !== null && typeof stream !== "string") {
		throw new WireDriftError(`event.stream must be a string or null; got ${typeof stream}`);
	}
	return {
		id: asNumber(row.id, "event.id"),
		runId: asString(row.runId, "event.runId"),
		seq: asNumber(row.seq, "event.seq"),
		ts: asString(row.ts, "event.ts"),
		kind: asString(row.kind, "event.kind"),
		stream,
		payload: row.payload,
	};
}
