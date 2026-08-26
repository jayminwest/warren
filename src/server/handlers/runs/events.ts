import { isTerminalRunState } from "../../../core/wire.ts";
import { tailRunEvents } from "../../../runs/index.ts";
import { ndjsonResponse } from "../../response.ts";
import { reserveEventStreamSlot } from "../../stream-limits.ts";
import type { Actor, RouteHandler, ServerDeps } from "../../types.ts";
import { parseBoolean, parseNonNegativeInt, parsePositiveInt, requireParam } from "../index.ts";
import { projectedWireEvent, type WireEventRow } from "./event-projection.ts";

export function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		const run = await deps.repos.runs.require(id);

		// warren-7bff: follow by DEFAULT while the run is non-terminal. A
		// bare `curl -N /runs/:id/events` (RUNBOOK-K8S's stream check) or any
		// client not passing `?follow=` must hold the connection on a live
		// run, not replay-then-close. Terminal runs keep replay-then-close;
		// an explicit `?follow=0|1` always wins.
		const followParam = parseBoolean(ctx.url.searchParams.get("follow"), "follow");
		// warren-17c1: `?limit=N` is a bounded NON-streaming read — at most N
		// events, then the response closes. It implies follow=false and wins
		// over an explicit `?follow=1`, because the caller asked for a cheap
		// page (liveness polls), not a held-open stream.
		const limit = parsePositiveInt(ctx.url.searchParams.get("limit"), "limit");
		const follow = limit === undefined ? (followParam ?? !isTerminalRunState(run.state)) : false;
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
			...(limit !== undefined ? { snapshotLimit: limit } : {}),
			signal: ctrl.signal,
			// warren-7bff: close the tail promptly when the run finishes even
			// if no live bridge remains to `broker.close` it (warren restart,
			// finalize racing the connect) — no dangling follow connections.
			terminal: {
				isTerminal: async () => {
					const row = await deps.repos.runs.get(id);
					return row === null || isTerminalRunState(row.state);
				},
			},
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
 * (warren-1cb7). The eight envelope keys are an allowlist by
 * construction; `projectEvent` owns the payload half and returns `null`
 * for an event a `readPublic`-only caller must not see at all.
 *
 * `origin` (warren-5a07) is classified spectator-safe: it is
 * provenance metadata (`"agent"` vs warren-authored), on par with
 * `stream`, and carries no payload content. NULL (historical rows,
 * warren-authored internal appends) stays null on the wire — unknown,
 * never folded into a real bucket.
 */
export function eventToNdjson(row: WireEventRow, actor?: Actor): string | null {
	const projected = projectedWireEvent(row, actor);
	if (projected === null) return null;
	return `${JSON.stringify(projected)}\n`;
}
