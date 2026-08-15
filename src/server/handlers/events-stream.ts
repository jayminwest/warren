/**
 * `GET /events/stream` (warren-f566, GH #847) — the global lifecycle
 * notification stream. One NDJSON line per run lifecycle transition,
 * projecting the Tier-1 bus's envelopes into the slim
 * {@link LifecycleStreamNotification} wire shape. It replaces the list
 * pages' 5s `/runs` polling: a tab holds one connection open and
 * invalidates its list queries on each line instead of re-fetching the
 * full payload forever. There is no replay — a notification is a pure
 * invalidation hint, so a reader that reconnects simply re-reads its
 * lists (the UI's 45s fallback poll covers the gap).
 *
 * Operator-gated (`readOperator`), unlike the per-run tails: a public
 * spectator on an instance gets list data at poll cadence but never a
 * held-open line feed carrying run ids for every project on the
 * instance (scenario 39's leak invariant).
 */

import type { LifecycleStreamNotification } from "../../runs/lifecycle-stream.ts";
import { notImplemented } from "../errors.ts";
import { jsonResponse, ndjsonResponse } from "../response.ts";
import { reserveEventStreamSlot } from "../stream-limits.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { parseBoolean } from "./index.ts";
import { asNdjsonStream, bridgeAbort } from "./runs/events.ts";

export function streamLifecycleEventsHandler(deps: ServerDeps): RouteHandler {
	return (ctx) => {
		const broker = deps.lifecycleStream;
		if (broker === undefined) {
			// Boot always wires the broker; absent means a test (or an
			// embedding) opted out. Refuse fast rather than hang open.
			const rendered = notImplemented("GET /events/stream");
			return jsonResponse(rendered.status, rendered.envelope);
		}

		// `follow` defaults to 1 — the stream is the whole point of the
		// route. `?follow=0` is a connection-probe shorthand: an immediate
		// clean close with an empty body.
		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? true;

		const ctrl = bridgeAbort(ctx.request.signal);
		const slot = reserveEventStreamSlot({
			limiter: deps.streamLimiter,
			ctx,
			ctrl,
			route: "GET /events/stream",
		});
		if (!follow) {
			slot.release();
			return ndjsonResponse(emptyStream());
		}

		const source = broker.subscribe({ signal: ctrl.signal });
		return ndjsonResponse(
			asNdjsonStream<LifecycleStreamNotification>(
				source,
				(notification) => `${JSON.stringify(notification)}\n`,
				ctrl,
				() => slot.release(),
			),
		);
	};
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
}
