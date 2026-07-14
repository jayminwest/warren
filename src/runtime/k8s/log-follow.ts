/**
 * The production `LogFollowFn` (pl-829f step 17 / warren-026c): the real
 * `@kubernetes/client-node` `Log.log` behind the `log-stream.ts` seam. Isolated
 * here so `log-stream.ts` — where the NDJSON parsing, seq synthesis, resume, and
 * rotation logic live — stays a pure, cluster-free unit tested against a scripted
 * fake `LogFollowFn`. This adapter is exercised end-to-end by the kind/k3d
 * validation (pl-829f step 25 / warren-245d), not by unit tests.
 *
 * `Log.log(namespace, pod, container, sink, options)` streams the container's log
 * into a `Writable` and resolves to an `AbortController`. We adapt that
 * stream-shaped surface onto the seam's `(onData, onDone)` callbacks: each write
 * becomes an `onData(chunk)`, and the stream's `finish` / `close` / `error`
 * becomes a single `onDone(err)`. `timestamps` is forced on (the RFC3339 prefix
 * is the resume anchor + seq witness). A from-start follow passes NEITHER
 * `sinceTime` nor `sinceSeconds`; a resume passes the explicit `sinceTime` anchor.
 */

import { type Readable, Writable } from "node:stream";
import { KubeConfig, Log, type LogOptions } from "@kubernetes/client-node";
import type { LogFollowController, LogFollowFn } from "./log-stream.ts";

/**
 * Is `err` the AbortError node-fetch (or the WHATWG stream) raises when a request
 * is aborted? Matched by `name`, the one field both the node-fetch `AbortError`
 * (`name === "AbortError"`) and the platform `DOMException` abort share. Scoped
 * deliberately narrow so ONLY the expected teardown signal is swallowed — every
 * other stream error still propagates into the pump's reconnect/backoff.
 */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Build the default lazy `LogFollowFn` factory: loads in-cluster (or kubeconfig)
 * config and constructs the `Log` client on FIRST call, memoized thereafter. Not
 * invoked at construction, so importing this never requires a reachable cluster
 * (mirrors `defaultCoreApiFactory`).
 */
export function defaultLogFollowFactory(): () => LogFollowFn {
	let cached: LogFollowFn | undefined;
	return () => {
		if (cached === undefined) {
			const kc = new KubeConfig();
			kc.loadFromDefault();
			cached = makeLogFollow(new Log(kc));
		}
		return cached;
	};
}

/** Adapt a `@kubernetes/client-node` `Log` client onto the seam's `LogFollowFn`. */
export function makeLogFollow(log: Log): LogFollowFn {
	return async (params, onData, onDone) => {
		let settled = false;
		let aborting = false;
		const finish = (err: unknown): void => {
			if (settled) return;
			settled = true;
			onDone(err);
		};
		const sink = new Writable({
			write(chunk: Buffer | string, _enc, cb): void {
				onData(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
				cb();
			},
		});
		sink.on("finish", () => finish(undefined));
		sink.on("close", () => finish(undefined));
		sink.on("error", (err) => finish(err));

		// `Log.log` does `response.body.pipe(sink)`, and `.pipe()` attaches NO
		// error listener to the SOURCE. When we tear the follow down after a
		// terminal (warren-fd08's prompt finalize fallback), `controller.abort()`
		// makes node-fetch emit an AbortError on `response.body`; with no listener
		// that `emit("error")` throws, and because it fires inside the signal's
		// abort-event dispatch it surfaces as an UNCAUGHT exception (a try/catch
		// around `abort.abort()` can't reach it) — the control plane crash-looped
		// on every K8s run teardown (warren-595f). The destination emits a `pipe`
		// event carrying the source, so capture the source here and route ITS
		// errors into the same single-settle `finish`: an AbortError (expected
		// teardown, or a race with our own abort) closes cleanly; every other
		// source error propagates to the pump exactly like a sink error.
		let source: Readable | undefined;
		sink.on("pipe", (src: Readable) => {
			source = src;
			src.on("error", (err) => {
				finish(aborting || isAbortError(err) ? undefined : err);
			});
		});

		// A resume passes the explicit `sinceTime` anchor; a from-start follow
		// passes NEITHER `sinceTime` nor `sinceSeconds`. `follow:true` with no
		// `since*`/`tailLines` replays the container's full retained log then tails
		// live — exactly the from-start-then-follow behavior we want. We must NOT
		// send `sinceSeconds: 0`: the apiserver validates `sinceSeconds > 0` and
		// rejects `0` with HTTP 422 ("must be greater than 0"). That 422 is not a
		// 404, so `log-stream.ts` treats it as a transient disconnect and re-sends
		// the same invalid request forever — the stream delivers zero bytes and the
		// run wedges in `queued` (warren-245d live k3d validation).
		const options: LogOptions = {
			follow: params.follow,
			timestamps: true,
			...(params.sinceTime !== undefined ? { sinceTime: params.sinceTime } : {}),
		};
		let abort: AbortController;
		try {
			abort = await log.log(params.namespace, params.podName, params.containerName, sink, options);
		} catch (err) {
			finish(err);
			return { abort: () => {} } satisfies LogFollowController;
		}
		return {
			abort: () => {
				// Mark the teardown BEFORE closing anything: the `pipe`-captured error
				// listener above must see `aborting` so any error the close produces is
				// treated as an expected clean end rather than a stream failure.
				aborting = true;
				// NEVER dispatch `abort.abort()` when the response source is in hand:
				// under Bun the abort-event dispatch constructs an AbortError
				// DOMException that surfaces as an UNCAUGHT exception OUTSIDE any
				// try/catch on this frame (8 crash-loop restarts on live GKE,
				// warren-4e36; the warren-595f pipe-listener alone did not stop it and
				// a try/catch around abort() does not either — the throw is async).
				// Destroying the piped source Readable closes the HTTP stream through
				// node-fetch's own teardown WITHOUT ever firing the abort signal; our
				// source error listener + `aborting` turn any resulting error into a
				// clean single-settle finish. The signal abort stays only as the
				// fallback for the (unreachable in practice) no-source case, still
				// guarded so teardown can never throw.
				try {
					if (source !== undefined) {
						source.destroy();
					} else {
						abort.abort();
					}
				} catch (err) {
					if (!isAbortError(err)) {
						finish(err);
						return;
					}
				}
				finish(undefined);
			},
		} satisfies LogFollowController;
	};
}
