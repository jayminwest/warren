import { tailRunEvents } from "../../../runs/index.ts";
import { ndjsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { parseBoolean, parseNonNegativeInt, requireParam } from "../index.ts";

export function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		const run = await deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		// warren-a8c3: tag every NDJSON envelope with the run's plot_id so
		// Plot-aware consumers can route mirrored events (warren-7e0f) without
		// a second GET /runs/:id call. Snapshot at stream-open time — plot_id
		// is set at spawn and never mutates, so the closure-captured value is
		// authoritative for the life of the stream.
		const plotId = run.plotId;
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, plotId), ctrl));
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

export function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

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
	plotId: string | null = null,
): string {
	return `${JSON.stringify({
		id: row.id,
		runId: row.runId,
		seq: row.burrowEventSeq,
		ts: row.ts,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
		plotId,
	})}\n`;
}
