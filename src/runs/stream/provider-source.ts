/**
 * Signal-adapting bridge over `provider.streamEvents` (warren-1f56). Split out of
 * `bridge.ts` to keep it under the file-size ratchet.
 *
 * The `RuntimeProvider` seam's event stream carries NO abort signal — abort rides
 * the async-iterator protocol (a consumer `break`/`return` tears down the
 * underlying burrow fetch). But `bridgeRunStream` stops the stream out-of-band
 * when the run-state poller (or an external shutdown) fires `ctrl.abort()`. This
 * adapter races each `.next()` against the signal and, on abort, `return()`s the
 * inner iterator — reproducing exactly what burrow's shared-signal fetch did
 * before the seam hid the signal. A transport error / neutralized 404 from
 * `.next()` propagates unchanged so the bridge's catch classifies it (errored /
 * sandboxRunMissing).
 *
 * ## Bounded teardown (warren-c433)
 * On abort the `finally` calls `iterator.return()` to tear the provider stream
 * down. `.return()` on an async generator suspended at an `await` (not a `yield`)
 * does NOT interrupt that await — it is queued until the await settles. The K8s
 * pod-log pump parks on `await queue.pull()` waiting for the next log chunk; if
 * the pod terminated without a clean follow EOF (the kubelet never closed the
 * stream), that pull never settles, so `iterator.return()` never resolves and the
 * post-terminal drain hangs FOREVER — the run-state poller observed terminal but
 * the bridge never reaches reap, so the row wedges `running` (the warren-c433
 * incident). We therefore RACE the teardown against a hard timeout: past it we
 * abandon the return (the generator leaks, its underlying follow is left to the
 * provider's own abort) and let the bridge proceed to terminal/reap regardless.
 */

import type {
	NormalizedEvent,
	RunHandle,
	RuntimeProvider,
	StreamOpts,
} from "../../runtime/contract.ts";
import type { StreamEventView } from "./types.ts";

/** Sentinel resolved by the abort race in `streamWithSignal`. */
const ABORTED = Symbol("stream-aborted");

/**
 * Hard ceiling on the provider-stream teardown (`iterator.return()`) after abort
 * (warren-c433). A hung K8s log pump can never wedge the bridge longer than this;
 * past it the drain is abandoned and the bridge proceeds to terminal/reap.
 */
export const DEFAULT_STREAM_TEARDOWN_MS = 5_000;

/**
 * Default stream-source factory: the run's `provider.streamEvents(handle)`
 * adapted to an `AbortSignal`. Returned shape matches the bridge's `source` seam
 * so a test override is drop-in interchangeable.
 */
export function providerStreamSource(
	provider: RuntimeProvider,
	handle: RunHandle,
	opts?: StreamOpts,
	teardownMs: number = DEFAULT_STREAM_TEARDOWN_MS,
): (signal: AbortSignal) => AsyncIterable<StreamEventView> {
	return (signal) => streamWithSignal(provider.streamEvents(handle, opts), signal, teardownMs);
}

export async function* streamWithSignal(
	inner: AsyncIterable<NormalizedEvent>,
	signal: AbortSignal,
	teardownMs: number = DEFAULT_STREAM_TEARDOWN_MS,
): AsyncGenerator<StreamEventView, void, void> {
	const iterator = inner[Symbol.asyncIterator]();
	try {
		while (!signal.aborted) {
			const nextPromise = iterator.next();
			const raced = await raceNextOrAbort(nextPromise, signal);
			if (raced === ABORTED) {
				// Abandon the in-flight `next()` — its rejection when the `finally`
				// tears the stream down must not surface as an unhandled rejection.
				void nextPromise.catch(() => {});
				return;
			}
			if (raced.done === true) return;
			yield raced.value;
		}
	} finally {
		// Consumer break / abort / natural end → close the provider stream so its
		// own `finally` aborts the underlying burrow fetch. Bounded (warren-c433):
		// a pump parked on an unresolvable `await` can't be interrupted by
		// `.return()`, so a hung teardown must not wedge the bridge — abandon it
		// past the ceiling and let the bridge reach terminal/reap.
		await boundedTeardown(iterator, teardownMs);
	}
}

/**
 * Race `iterator.return()` against a `teardownMs` ceiling. On timeout the return
 * promise is abandoned (its later rejection swallowed) so a hung provider-stream
 * teardown can never block the bridge's path to reap (warren-c433). A
 * non-positive `teardownMs` awaits the return unbounded (opt-out / tests).
 */
async function boundedTeardown(
	iterator: AsyncIterator<NormalizedEvent>,
	teardownMs: number,
): Promise<void> {
	const ret = iterator.return?.(undefined);
	if (ret === undefined) return;
	if (teardownMs <= 0) {
		await ret.catch(() => {});
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, teardownMs);
	});
	try {
		await Promise.race([ret.catch(() => {}), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		// Swallow a late rejection from an abandoned (timed-out) return.
		void ret.catch(() => {});
	}
}

/**
 * Resolve to the iterator's next result, or the `ABORTED` sentinel when `signal`
 * fires first. A rejection from `next()` (transport error / neutralized 404)
 * rejects the race so the generator throws it to the bridge's catch. The abort
 * listener is removed as soon as `next()` settles, so a long stream doesn't
 * accumulate listeners on the signal.
 */
function raceNextOrAbort(
	nextPromise: Promise<IteratorResult<NormalizedEvent, void>>,
	signal: AbortSignal,
): Promise<IteratorResult<NormalizedEvent, void> | typeof ABORTED> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			resolve(ABORTED);
		};
		if (signal.aborted) {
			resolve(ABORTED);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		nextPromise.then(
			(result) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(err) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}
