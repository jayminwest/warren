import { tailRunEvents } from "../../../runs/index.ts";
import { ndjsonResponse } from "../../response.ts";
import { reserveEventStreamSlot } from "../../stream-limits.ts";
import type { Actor, RouteHandler, ServerDeps } from "../../types.ts";
import { parseBoolean, parseNonNegativeInt, requireParam } from "../index.ts";
import { projectEvent } from "./event-projection.ts";

export function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		await deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		// Concurrency admission (warren-25f6) — AFTER the 404 so a typo'd id
		// never burns a slot, BEFORE any streaming work so a refusal is a fast
		// 503 + Retry-After rather than a connection warren has to hold.
		const slot = reserveEventStreamSlot({
			limiter: deps.streamLimiter,
			ctx,
			ctrl,
			route: "GET /runs/:id/events",
		});
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		return ndjsonResponse(
			asNdjsonStream(
				source,
				(row) => eventToNdjson(row, ctx.actor),
				ctrl,
				() => slot.release(),
			),
		);
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming plumbing                                                       */
/* ----------------------------------------------------------------------- */

export function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

/**
 * `onClose` (warren-25f6) fires exactly once the stream is no longer
 * attached — normal end-of-source, error, or client cancel. It carries the
 * event-stream slot release, so it runs BEFORE each exit's
 * `controller.close()` / `.error()`: those can themselves throw on a stream
 * the runtime already tore down, and a leaked slot would permanently shrink
 * the instance's capacity. `EventStreamSlot.release` is idempotent, so the
 * overlap between these paths is harmless.
 */
export function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string | null,
	ctrl: AbortController,
	onClose?: () => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				// warren-1cb7: `encode` returns null for a value the projection
				// dropped. Pull the next one instead of enqueuing a blank chunk —
				// a dropped event must be absent from the wire, not an empty line.
				while (true) {
					const { done, value } = await iterator.next();
					if (done) {
						onClose?.();
						controller.close();
						return;
					}
					const line = encode(value);
					if (line === null) continue;
					controller.enqueue(encoder.encode(line));
					return;
				}
			} catch (err) {
				onClose?.();
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			onClose?.();
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

/**
 * Encode one event row as an NDJSON line, narrowed for `actor`
 * (warren-1cb7). The seven envelope keys are an allowlist by
 * construction; `projectEvent` owns the payload half and returns `null`
 * for an event a `readPublic`-only caller must not see at all.
 */
export function eventToNdjson(
	row: {
		id: number;
		runId: string;
		burrowEventSeq: number;
		ts: string;
		kind: string;
		stream: string | null;
		payloadJson: unknown;
	},
	actor?: Actor,
): string | null {
	const projected = projectEvent(row, actor);
	if (projected === null) return null;
	return `${JSON.stringify({
		id: projected.id,
		runId: projected.runId,
		seq: projected.burrowEventSeq,
		ts: projected.ts,
		kind: projected.kind,
		stream: projected.stream,
		payload: projected.payloadJson,
	})}\n`;
}
