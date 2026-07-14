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

import { Writable } from "node:stream";
import { KubeConfig, Log, type LogOptions } from "@kubernetes/client-node";
import type { LogFollowController, LogFollowFn } from "./log-stream.ts";

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
				abort.abort();
				finish(undefined);
			},
		} satisfies LogFollowController;
	};
}
