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
 * burrowRunMissing).
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
 * Default stream-source factory: the run's `provider.streamEvents(handle)`
 * adapted to an `AbortSignal`. Returned shape matches the bridge's `source` seam
 * so a test override is drop-in interchangeable.
 */
export function providerStreamSource(
	provider: RuntimeProvider,
	handle: RunHandle,
	opts?: StreamOpts,
): (signal: AbortSignal) => AsyncIterable<StreamEventView> {
	return (signal) => streamWithSignal(provider.streamEvents(handle, opts), signal);
}

async function* streamWithSignal(
	inner: AsyncIterable<NormalizedEvent>,
	signal: AbortSignal,
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
		// own `finally` aborts the underlying burrow fetch.
		await iterator.return?.(undefined).catch(() => {});
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
