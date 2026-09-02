/**
 * Hand-derived wire types for the warren HTTP surfaces the judge reads:
 * `GET /runs` (terminal-run discovery), `GET /runs/:id` (run facts), and
 * `GET /runs/:id/events` (the bounded NDJSON tail).
 *
 * FRICTION §2 (extensions/audit-log/FRICTION.md): there is no published
 * client artifact and the generated OpenAPI carries no response schemas
 * (warren-b9ec), so these shapes are re-declared here from the handler
 * source and confirmed against the fake warren. Drift is caught by runtime
 * narrowing at the parse boundary ({@link WireDriftError}), never by a
 * compiler.
 *
 * Third-party posture: parse only the fields the judge needs and tolerate
 * everything else, so additive server fields never break the extension.
 * Distinct from `wire.ts`, which owns the judge's OWN verdict vocabulary —
 * this file owns warren's read shapes.
 */

/** Raised at the parse boundary when a response no longer matches the
 * hand-derived contract — the only drift detection an out-of-core
 * extension gets. */
export class WireDriftError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(`warren wire drift: ${detail}`);
		this.name = "WireDriftError";
		this.detail = detail;
	}
}

/** Closed run lifecycle vocabulary, mirroring warren's `RUN_STATES`. */
export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const;

/** True once a run can no longer change state — the judge's discovery gate. */
export function isTerminalRunState(state: RunState): boolean {
	return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Infrastructure failure vocabulary, mirroring warren's
 * `RUN_FAILURE_REASONS` (`src/core/wire.ts`). Behavioral failures are the
 * judge's own taxonomy (`wire.ts`); this is the ground-truth infrastructure
 * arm the judge reads to separate "the platform failed" from "the agent
 * failed". Hand-maintained on purpose — extensions never import `src/` — so
 * keep it in core's order and append when core grows (warren-4e2a /
 * warren-ba08 added `spawn_failed`, `no_changes`, `push_rejected_policy`;
 * warren-7f0b added `agent_died`).
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"sandbox_failed",
	"spawn_failed",
	"crashed",
	"agent_died",
	"timed_out",
	"sandbox_run_lost",
	"sandbox_unreachable",
	"dropped_commit",
	"no_changes",
	"finalize_failed",
	"push_rejected_policy",
	"finalize_unposted",
	"provider_error",
	"oom_killed",
	"evicted",
	// warren-ea4b: GKE Spot node reclaimed under the run pod — K8s-only,
	// retryable (the substrate lost the run, not the agent).
	"preempted",
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/** PR lifecycle as the merge watcher records it, mirroring warren's
 * `PULL_REQUEST_LIFECYCLES`. */
export const PULL_REQUEST_LIFECYCLES = ["open", "merged", "closed_unmerged"] as const;
export type PullRequestLifecycle = (typeof PULL_REQUEST_LIFECYCLES)[number];

/**
 * The slice of a `GET /runs` row the judge reads for discovery. Every
 * other field is passed through untouched.
 */
export interface RunListRow {
	readonly id: string;
	readonly state: RunState;
	/** ISO string; the list sorts `started desc`. Nullable pre-start. */
	readonly startedAt: string | null;
}

/** The `GET /runs` response envelope (paginated by `?limit`/`?offset`). */
export interface RunListPage {
	readonly runs: RunListRow[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
}

/**
 * The run facts the judge reads from `GET /runs/:id`: outcome, failure
 * reason, cost, and PR ground truth. Nullable columns read as "none" or
 * "unknown" per the schema comments — never as zero / not-merged.
 */
export interface RunDetail {
	readonly id: string;
	readonly state: RunState;
	/** Infrastructure failure cause; null on success / pre-column rows. */
	readonly failureReason: RunFailureReason | null;
	/** USD spend; null when the runtime never reported session stats. */
	readonly costUsd: number | null;
	/** Null when no PR was opened (auto-open off, push failed, …). */
	readonly prUrl: string | null;
	/** Merge-watcher PR facts; null = unknown, never "not merged". */
	readonly prState: PullRequestLifecycle | null;
	readonly prMergedAt: string | null;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
}

/**
 * One NDJSON line from `GET /runs/:id/events`. `seq` is monotonic PER RUN,
 * not globally, so the judge pages with a per-run `since` cursor.
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

function asNullableString(value: unknown, what: string): string | null {
	if (value === null || value === undefined) return null;
	return asString(value, what);
}

function asEnum<T extends string>(
	value: unknown,
	what: string,
	vocabulary: readonly T[],
): T {
	const raw = asString(value, what);
	if (!vocabulary.includes(raw as T)) {
		throw new WireDriftError(`${what} '${raw}' is outside the known vocabulary ${vocabulary.join("|")}`);
	}
	return raw as T;
}

function asNullableEnum<T extends string>(
	value: unknown,
	what: string,
	vocabulary: readonly T[],
): T | null {
	if (value === null || value === undefined) return null;
	return asEnum(value, what, vocabulary);
}

/** Narrow one entry of the `runs` array, tolerating every other field. */
export function parseRunListRow(value: unknown): RunListRow {
	const row = asRecord(value, "runs[] entry");
	const id = asString(row.id, "runs[].id");
	return {
		id,
		state: asEnum(row.state, `runs[${id}].state`, RUN_STATES),
		startedAt: asNullableString(row.startedAt, `runs[${id}].startedAt`),
	};
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

/**
 * Narrow the `GET /runs/:id` response. BOTH `POST /runs` and
 * `GET /runs/:id` wrap the payload as `{run: {...}}` (warren-7d84) —
 * parse the envelope, never the bare body.
 */
export function parseRunDetail(value: unknown): RunDetail {
	const body = asRecord(value, "GET /runs/:id response");
	const run = asRecord(body.run, "GET /runs/:id .run (the {run} envelope)");
	const id = asString(run.id, "run.id");
	return {
		id,
		state: asEnum(run.state, `run[${id}].state`, RUN_STATES),
		failureReason: asNullableEnum(run.failureReason, `run[${id}].failureReason`, RUN_FAILURE_REASONS),
		costUsd: run.costUsd === null || run.costUsd === undefined
			? null
			: asNumber(run.costUsd, `run[${id}].costUsd`),
		prUrl: asNullableString(run.prUrl, `run[${id}].prUrl`),
		prState: asNullableEnum(run.prState, `run[${id}].prState`, PULL_REQUEST_LIFECYCLES),
		prMergedAt: asNullableString(run.prMergedAt, `run[${id}].prMergedAt`),
		startedAt: asNullableString(run.startedAt, `run[${id}].startedAt`),
		endedAt: asNullableString(run.endedAt, `run[${id}].endedAt`),
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
