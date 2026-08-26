/**
 * Public projection for the run event stream (warren-1cb7 / pl-b82d step 16).
 *
 * `events.payload_json` is the raw agent transcript: `tool_use` inputs
 * carrying shell command lines, `tool_result` outputs carrying file
 * contents and stack traces. It is served verbatim as NDJSON from
 * `GET /runs/:id/events` and its plan-run twin, both `readPublic` routes.
 * That makes it the widest disclosure surface on a public instance and the
 * one place where the field-allowlist discipline of
 * `src/server/projection.ts` does not reach — the payload is a free-form
 * blob whose interesting content is exactly the part we cannot enumerate.
 *
 * So the projection here is two narrower moves:
 *
 * 1. {@link INTERNAL_EVENT_KINDS} — event kinds dropped whole, because
 *    their payload is control-plane plumbing and nothing else.
 * 2. {@link RAW_FAILURE_EVENT_KINDS} — failure kinds kept on the stream
 *    (`state: "failed"` is spectator-visible fact) but whose payload
 *    carries raw subprocess stderr and absolute host paths, so the
 *    `message` is replaced with the marker and `path` is stripped whole.
 * 3. `scrubSecrets` — a deep walk that replaces known credential
 *    shapes, secret-named fields, and this instance's own env secrets with
 *    `REDACTED_MARKER`. A visible marker, never a deletion, so a
 *    viewer can tell scrubbing happened rather than wondering whether the
 *    agent said nothing.
 *
 * Both run server-side, on the NDJSON projection. The stream IS the API
 * (PHILOSOPHY rule 5); anything relying on the UI to redact is not
 * redacted, since a spectator can `curl` the same route.
 *
 * **Why the kind list is a denylist** when `src/server/projection.ts`
 * mandates allowlists: `NormalizedEvent.kind` is an OPEN string
 * (`src/runtime/contract.ts` §6.6) — burrow and the K8s log parser forward
 * whatever the harness emits, and new kinds arrive with runtime releases
 * warren does not gate. An allowlist there would silently swallow the
 * transcript on the next burrow bump, i.e. break the surface it is meant
 * to protect. The allowlist discipline still holds where the vocabulary is
 * closed — the NDJSON envelope names its fields explicitly in
 * `eventToNdjson` — and the scrubber runs over every payload regardless of
 * kind, so an unclassified kind is scrubbed, not trusted.
 *
 * **Residual risk, explicitly accepted.** An agent that echoes a NOVEL
 * secret — one matching none of the shapes the scrubber knows and absent
 * from this instance's env — into a stack trace lands verbatim. No pattern
 * matcher closes that gap. The structural mitigation is the
 * public-instance org allowlist (warren-ce9b): every repo the instance
 * runs against is public, so the workspace content a transcript quotes is
 * already public. Read this module as the floor under an already-public
 * surface, not as a promise that arbitrary agent output is safe to expose.
 *
 * warren-4001: the scrub primitives themselves live in
 * `src/observability/event-scrub.ts` so the reap path
 * (`src/runs/reap/provider-error.ts`) can redact provider-error text
 * BEFORE storing it; they are re-exported here so existing consumers keep
 * one import site.
 */

import {
	buildEnvSecretPattern,
	instanceEnvSecretPattern,
	REDACTED_MARKER,
	scrubSecrets,
} from "../../../observability/event-scrub.ts";
import { isPublicOnly } from "../../projection.ts";
import type { Actor } from "../../types.ts";

export { buildEnvSecretPattern, REDACTED_MARKER, scrubSecrets };

/**
 * Event kinds a `readPublic`-only caller never sees.
 *
 * The bridge lifecycle events are warren's own reconnect bookkeeping and
 * their payloads are `{ sandboxRunId, sandboxId, attempts, … }` — the
 * internal runtime handles `REDACTED_RUN_FIELDS` (warren-946f) already
 * withholds from the run row. Serving them here would hand back through
 * the transcript exactly what the run projection drops, and a spectator
 * has no use for them either way.
 *
 * Keep this list to kinds that are *purely* internal. A kind that carries
 * any spectator-visible fact (`spawn_failed`, `reap_failed`, `budget.exceeded`)
 * stays on the stream — the failure kinds get {@link sanitizeFailurePayload}
 * instead of a drop, and everything else is scrubbed like everything else.
 */
export const INTERNAL_EVENT_KINDS: ReadonlySet<string> = new Set([
	"bridge_stalled",
	"bridge_recovered",
	"bridge_lost",
	"bridge_fatal",
]);

/**
 * Failure kinds whose payload `message` is raw subprocess stderr and whose
 * optional `path` is an absolute host workspace path
 * (`src/runs/reap/run.ts` `fail()`, `src/runs/reap/mulch.ts`,
 * `src/runs/spawn/rollback.ts`). The credential scrubber cannot help here:
 * a `/data/…` host path and an arbitrary stderr tail match no credential
 * shape, yet they disclose exactly what `REDACTED_RUN_FIELDS` withholds
 * from the run row (`localPath`, `previewFailureMessage`) — warren-cbd8.
 *
 * The event itself stays: the failure IS spectator-visible fact. What the
 * public projection applies is the body/log split (warren-4385): `step`
 * (a closed `ReapStep` vocabulary) survives, `message` is replaced with
 * the marker, `path` is stripped whole. The full text stays where it
 * belongs — the operator stream, which gets the row by reference.
 *
 * `reap.workspace_salvage_failed` (warren-cd3b) joins them in warren-7c1e:
 * its whole payload is `errors[]`, raw git stderr from the rescue push and
 * the bundle capture, which quotes the absolute `<salvageDir>/<runId>.bundle`
 * target. "The salvage failed" is the spectator-visible fact and the kind
 * alone carries it; the stderr is operator-only.
 */
export const RAW_FAILURE_EVENT_KINDS: ReadonlySet<string> = new Set([
	"reap_failed",
	"spawn_failed",
	"reap.workspace_salvage_failed",
]);

/**
 * The body half of the body/log split for {@link RAW_FAILURE_EVENT_KINDS}:
 * keep every field except `path` (stripped — no marker, the field existing
 * at all is operator-only shape) and the free-text carriers `message` and
 * `errors[]` (replaced with the marker, element-wise for the array so the
 * count of distinct failures survives).
 */
function sanitizeFailurePayload(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return payload;
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (key === "path") continue;
		if (key === "message") {
			out[key] = REDACTED_MARKER;
			continue;
		}
		if (key === "errors" && Array.isArray(value)) {
			out[key] = value.map(() => REDACTED_MARKER);
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * The wire shape of one event — the exact keys the NDJSON line and the
 * JSON `GET /events` row share. One mapping site, two encodings.
 */
export interface WireEvent {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly origin: string | null;
	readonly payload: unknown;
}

/**
 * Narrow one event row for `actor` and map it onto the eight-key wire
 * shape. Returns `null` for an event the public projection drops
 * entirely — the caller omits it from the wire rather than serving a
 * placeholder. Shared by the per-run NDJSON encoder (`eventToNdjson`)
 * and the global JSON query (`GET /events`) so the two surfaces cannot
 * drift (warren-5eec).
 */
export function projectedWireEvent<T extends ProjectableEvent & WireEventRow>(
	row: T,
	actor: Actor | undefined,
): WireEvent | null {
	const projected = projectEvent(row, actor);
	if (projected === null) return null;
	return {
		id: projected.id,
		runId: projected.runId,
		seq: projected.sandboxEventSeq,
		ts: projected.ts,
		kind: projected.kind,
		stream: projected.stream,
		origin: projected.origin,
		payload: projected.payloadJson,
	};
}

/** Structural parent of the rows {@link projectedWireEvent} accepts. */
export interface WireEventRow {
	readonly id: number;
	readonly kind: string;
	readonly runId: string;
	readonly sandboxEventSeq: number;
	readonly ts: string;
	readonly stream: string | null;
	readonly origin: string | null;
	readonly payloadJson: unknown;
}

/** The shape the projection reads. Structurally satisfied by an `EventRow`. */
interface ProjectableEvent {
	readonly kind: string;
	readonly payloadJson: unknown;
}

/**
 * Narrow one event row for `actor`. The operator gets the row by
 * reference, untouched — the public stream is provably the operator
 * stream minus content, because there is only one construction site.
 *
 * `null` means the event is dropped entirely; the NDJSON encoder turns
 * that into no line on the wire rather than an empty one.
 */
export function projectEvent<T extends ProjectableEvent>(
	row: T,
	actor: Actor | undefined,
): T | null {
	if (!isPublicOnly(actor)) return row;
	if (INTERNAL_EVENT_KINDS.has(row.kind)) return null;
	const payload = RAW_FAILURE_EVENT_KINDS.has(row.kind)
		? sanitizeFailurePayload(row.payloadJson)
		: row.payloadJson;
	return { ...row, payloadJson: scrubSecrets(payload, instanceEnvSecretPattern()) };
}
