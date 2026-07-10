/**
 * `LocalProvider.streamEvents` body (pl-829f step 9, phase CONTRACT). Wraps
 * burrow's run event stream — the SAME `GET /runs/:id/stream` NDJSON endpoint
 * `src/runs/stream/bridge.ts` consumes today — and re-shapes each burrow
 * `RunEvent` onto the seam's provider-neutral `NormalizedEvent`.
 *
 * Faithful to `bridge.ts`'s burrow-touching half:
 *   - Source: `client.http.runs.stream(burrowRunId, { signal })`, wrapped in
 *     `withTransportMapping` so a dead socket surfaces as
 *     `BurrowUnreachableError` (this is now the bridge's production stream source
 *     — the domain routes through `provider.streamEvents`, warren-1f56).
 *   - Resume: burrow's `runs.stream` has NO server-side `since` param — it
 *     replays from the run's first event every time — so resume is the SAME
 *     client-side dedup bridge does: skip `event.seq <= sinceSeq` (contract
 *     `StreamOpts`). Nothing rides Last-Event-ID / a query cursor today.
 *   - seq: burrow server-assigns a per-run monotonic `seq`; the provider passes
 *     it through as the guaranteed cursor (§6.4 — free for Local).
 *   - payload: forwarded VERBATIM (§6.6 lossless — the cost extractor reads
 *     `total_cost_usd`/`usage` out of it; the provider must not drop a field).
 *
 * Abort: `StreamOpts` carries no signal, so cancellation rides the async-iterator
 * protocol — when the consumer breaks/returns/throws out of its `for await`, the
 * runtime calls this generator's `.return()`, the `finally` aborts the internal
 * controller, and the abort propagates into burrow's stream (its own
 * `streamRunEvents` listens on the passed signal and cancels the fetch reader).
 */

import { NotFoundError as BurrowNotFoundError, type RunEvent } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/index.ts";
import { withTransportMapping } from "../../burrow-client/index.ts";
import type { NormalizedEvent, StreamOpts } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";

/** The three stream tags the seam recognizes; anything else coerces to `null`. */
const NORMALIZED_STREAMS = ["stdout", "stderr", "system"] as const;

/**
 * Stream burrow's run events as `NormalizedEvent`s. Sync-returns the generator
 * (matching `RuntimeProvider.streamEvents`); the body runs lazily on first
 * `.next()`, so the caller resolving the client eagerly is intentional.
 */
export function streamLocalEvents(
	client: BurrowClient,
	burrowRunId: string,
	opts?: StreamOpts,
): AsyncGenerator<NormalizedEvent, void, void> {
	return pumpLocalEvents(client, burrowRunId, opts?.sinceSeq ?? 0);
}

async function* pumpLocalEvents(
	client: BurrowClient,
	burrowRunId: string,
	sinceSeq: number,
): AsyncGenerator<NormalizedEvent, void, void> {
	const ctrl = new AbortController();
	const source = client.http.runs.stream(burrowRunId, { signal: ctrl.signal });
	try {
		for (;;) {
			// Transport-map each pull: the initial fetch is lazy (fires on the first
			// `.next()`), so a dead socket must surface here as BurrowUnreachableError.
			// A burrow 404 (the run vanished mid-stream — machine restart wiped
			// burrow's in-memory store, deliberate cleanup) is NEUTRALIZED at the
			// seam (warren-1f56): re-thrown as the provider-neutral
			// `RuntimeRunNotFoundError` so the domain bridge recognizes a ghost run
			// without importing `@os-eco/burrow-cli`'s error class. Mirrors the same
			// neutralization `./cancel.ts` / `./send-message.ts` do.
			let next: IteratorResult<RunEvent, void>;
			try {
				next = await withTransportMapping(client.config, () => source.next());
			} catch (err) {
				if (err instanceof BurrowNotFoundError) {
					throw new RuntimeRunNotFoundError(err.message, {
						recoveryHint: "the run is unknown to the backend; reconcile the warren row as lost",
					});
				}
				throw err;
			}
			if (next.done === true) break;
			const event = next.value;
			// Resume dedup — client-side skip, exactly as bridge.ts does.
			if (event.seq <= sinceSeq) continue;
			yield normalizeEvent(event);
		}
	} finally {
		// Consumer break / throw / normal end lands here. Abort the underlying
		// stream and close the inner generator so the fetch reader tears down.
		ctrl.abort();
		await source.return(undefined).catch(() => {});
	}
}

/** Re-shape a burrow `RunEvent` onto the seam's `NormalizedEvent` (payload lossless). */
function normalizeEvent(event: RunEvent): NormalizedEvent {
	return {
		seq: event.seq,
		ts: toIsoString(event.ts),
		kind: event.kind,
		stream: normalizeStream(event.stream),
		payload: event.payload,
	};
}

/**
 * Coerce burrow's `stream` tag onto the seam's `"stdout"|"stderr"|"system"|null`.
 * An unrecognized value (a forward-compatible burrow shipping a new tag) coerces
 * to `null` rather than crashing — same tolerance `bridge.ts`'s `normalizeStream`
 * has, kept local so the runtime seam does not couple to warren's db schema.
 */
function normalizeStream(value: unknown): NormalizedEvent["stream"] {
	return typeof value === "string" && (NORMALIZED_STREAMS as readonly string[]).includes(value)
		? (value as NormalizedEvent["stream"])
		: null;
}

function toIsoString(ts: Date | string): string {
	return ts instanceof Date ? ts.toISOString() : ts;
}
