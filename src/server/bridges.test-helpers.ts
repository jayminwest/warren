import type { RunTerminalState } from "../db/schema.ts";
import type { ReapRunResult } from "../runs/index.ts";
import { makeReapRunResult } from "../runs/reap/test-helpers.ts";
import type {
	RunHandle,
	RunPhase,
	RunStatus,
	RuntimeProvider,
	TeardownResult,
} from "../runtime/contract.ts";

/**
 * Shared fixtures for the stream-bridge registry tests (`bridges*.test.ts`)
 * and the reconnect/stall tests (`bridge-reconnect.test.ts`).
 *
 * warren-5a3f: the registry + reconnect chain now consume a boot-resolved
 * `RuntimeProvider` and no longer touch a burrow client, so these fixtures speak
 * the provider seam directly instead of stubbing burrow HTTP. `status()` drives
 * the `bootBridges` ghost-run pre-probe (via `exists`), and `terminate()` records
 * the lost-run teardown handles the reconciler hands the seam.
 */

export interface FakeProviderOpts {
	/** `status().exists` — `false` models a GC'd pod / burrow 404 (ghost run). */
	readonly exists?: boolean;
	/** `status().phase` — defaults to `"running"`. */
	readonly phase?: RunPhase;
	/** Make `terminate()` throw (models a pod-delete / burrow-destroy failure). */
	readonly throwOnTerminate?: Error;
}

export interface FakeProvider {
	readonly provider: RuntimeProvider;
	/** Handles passed to `terminate()`, in call order. */
	readonly terminateCalls: RunHandle[];
	/** Handles passed to `status()`, in call order. */
	readonly statusCalls: RunHandle[];
}

/**
 * Minimal `RuntimeProvider` fake exposing the two methods the bridge registry
 * and reconnect chain actually call — `status()` (ghost-run pre-probe) and
 * `terminate()` (lost-run teardown). Every other method is absent; tests that
 * stub the `bridge` factory never reach them.
 */
export function makeProvider(opts: FakeProviderOpts = {}): FakeProvider {
	const terminateCalls: RunHandle[] = [];
	const statusCalls: RunHandle[] = [];
	const provider = {
		status: async (handle: RunHandle): Promise<RunStatus> => {
			statusCalls.push(handle);
			return {
				phase: opts.phase ?? "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: opts.exists ?? true,
			};
		},
		terminate: async (handle: RunHandle): Promise<TeardownResult> => {
			terminateCalls.push(handle);
			if (opts.throwOnTerminate !== undefined) throw opts.throwOnTerminate;
			return { archived: false, deletedEvents: 3, deletedMessages: 1, deletedRuns: 1 };
		},
	} as unknown as RuntimeProvider;
	return { provider, terminateCalls, statusCalls };
}

export function reapStub(outcome: RunTerminalState): ReapRunResult {
	return makeReapRunResult({ state: outcome });
}
