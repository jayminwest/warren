/**
 * Global lifecycle notification stream (warren-f566, GH #847).
 *
 * The list pages used to poll `/runs` + `/plan-runs` every 5s per open
 * tab, dominating request volume and driving egress from ~100MB/day to
 * ~2GB/day. The fix is a slim, instance-wide notification stream: one
 * NDJSON connection per tab receives `{runId, hook, state, ts}` lines
 * and the UI debounce-invalidates its list queries on each line, with a
 * slow fallback poll underneath. Bytes flow only when a run changes
 * state, which is exactly the signal the list pages re-fetch on.
 *
 * Two pieces live here:
 *
 *   `LifecycleStreamBroker` — a global, run-agnostic pub/sub twin of the
 *      per-run {@link RunEventBroker} (`./events.ts`). Subscribers are
 *      async generators with bounded per-subscriber queues so a slow
 *      consumer cannot stall the emit path; overflow drops FIFO and
 *      surfaces as the `dropped` counter.
 *
 *   `createLifecycleStreamExtension` — the {@link LifecycleExtension}
 *      that feeds the broker from the Tier-1 observation bus
 *      (`./lifecycle-bus.ts`, warren-4e74). Boot subscribes it through
 *      the same `registerExtensions` batch as the healer / seed-close
 *      consumers. `event_emitted` is deliberately NOT subscribed — it is
 *      one line per run-event row and would turn the global stream into
 *      the firehose it exists to replace; the per-run tail keeps that
 *      granularity.
 */

import type { RunState } from "../core/wire.ts";
import type { LifecycleExtension, LifecycleHook, LifecycleOutcome } from "./lifecycle-bus.ts";
import { WARREN_EXT_PROTOCOL } from "./lifecycle-bus.ts";

/**
 * One slim notification on the global stream. `state` is the run's
 * best-known {@link RunState} AFTER the transition the hook names, or
 * `null` when the hook carries no state change (`branch_pushed` —
 * the row's state was settled at `post_reap`).
 */
export interface LifecycleStreamNotification {
	readonly runId: string;
	readonly hook: LifecycleHook;
	readonly state: RunState | null;
	/** ISO timestamp of the lifecycle envelope the notification projects. */
	readonly ts: string;
}

export interface LifecycleStreamSubscribeOptions {
	readonly signal?: AbortSignal;
	/** Maximum buffered notifications before the broker drops (FIFO). */
	readonly bufferSize?: number;
}

/** Default per-subscriber queue cap — a fleet-wide burst shouldn't OOM a stuck tab. */
export const DEFAULT_LIFECYCLE_STREAM_BUFFER = 512;

interface LifecycleStreamSubscription {
	push(notification: LifecycleStreamNotification): void;
	end(): void;
}

/**
 * In-memory, process-wide notification fan-out. Unlike {@link
 * RunEventBroker} there is no durable backing table and no replay: the
 * UI reconnects and re-reads its list queries anyway (notifications are
 * pure invalidation hints), so a dropped line costs one fallback-poll
 * interval, nothing more. Not durable by design.
 */
export class LifecycleStreamBroker {
	private readonly subs = new Set<LifecycleStreamSubscription>();

	publish(notification: LifecycleStreamNotification): void {
		for (const sub of this.subs) sub.push(notification);
	}

	/** Test/diagnostic surface — number of currently-attached subscribers. */
	subscriberCount(): number {
		return this.subs.size;
	}

	/**
	 * Open a live subscription. Yields notifications published after the
	 * call returns. Cancellation via `signal`, or the consumer breaking
	 * out of the generator, detaches the subscription synchronously.
	 */
	subscribe(
		opts: LifecycleStreamSubscribeOptions = {},
	): AsyncGenerator<LifecycleStreamNotification, void, void> {
		const bufferSize = opts.bufferSize ?? DEFAULT_LIFECYCLE_STREAM_BUFFER;
		const queue: LifecycleStreamNotification[] = [];
		let waiter: (() => void) | null = null;
		let ended = false;

		const wake = (): void => {
			if (waiter) {
				const fn = waiter;
				waiter = null;
				fn();
			}
		};
		const sub: LifecycleStreamSubscription = {
			push(notification) {
				if (ended) return;
				// FIFO drop under overflow — a dropped line costs one fallback-poll
				// interval, and the UI re-reads its lists anyway (module header).
				if (queue.length >= bufferSize) queue.shift();
				queue.push(notification);
				wake();
			},
			end() {
				ended = true;
				wake();
			},
		};
		this.subs.add(sub);

		const signal = opts.signal;
		const onAbort = (): void => sub.end();
		if (signal !== undefined) {
			if (signal.aborted) sub.end();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const subs = this.subs;
		return (async function* (): AsyncGenerator<LifecycleStreamNotification, void, void> {
			try {
				while (true) {
					const next = queue.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (ended) return;
					await new Promise<void>((resolve) => {
						waiter = resolve;
					});
				}
			} finally {
				signal?.removeEventListener("abort", onAbort);
				subs.delete(sub);
				sub.end();
			}
		})();
	}
}

/** Map the terminal-hook outcome onto the canonical run-state vocabulary. */
function outcomeToState(outcome: LifecycleOutcome): RunState {
	return outcome;
}

/**
 * The bus extension that projects lifecycle envelopes into slim stream
 * notifications. Subscribes to exactly the hooks a list page cares
 * about — lifecycle transitions, not per-event rows. See the module
 * header for why `event_emitted` is absent.
 */
export function createLifecycleStreamExtension(broker: LifecycleStreamBroker): LifecycleExtension {
	const publish = (
		hook: LifecycleHook,
		runId: string,
		state: RunState | null,
		ts: string,
	): void => {
		broker.publish({ runId, hook, state, ts });
	};
	return {
		name: "lifecycle-stream",
		protocol: WARREN_EXT_PROTOCOL,
		hooks: {
			run_dispatched: (env) => publish(env.hook, env.runId, "queued", env.at),
			run_started: (env) => publish(env.hook, env.runId, "running", env.at),
			pre_reap: (env) => publish(env.hook, env.runId, outcomeToState(env.payload.outcome), env.at),
			post_reap: (env) => publish(env.hook, env.runId, outcomeToState(env.payload.outcome), env.at),
			branch_pushed: (env) => publish(env.hook, env.runId, null, env.at),
		},
	};
}
