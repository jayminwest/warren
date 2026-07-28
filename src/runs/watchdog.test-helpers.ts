/**
 * Shared fixtures for the watchdog test suites (`watchdog.test.ts` +
 * `watchdog-reconcile.test.ts`). Extracted so both stay under the file-size
 * ratchet without duplicating the agent-json / reap-result / provider fakes.
 */

import type { RunHandle, RunStatus, RuntimeProvider } from "../runtime/contract.ts";
import type { ReapRunResult } from "./reap/index.ts";

export const PROJECT_ID = "prj_xxxxxxxxxxxx";

export function makeAgentJson() {
	return {
		name: "claude-code",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

export function fakeReapResult(state: ReapRunResult["state"]): ReapRunResult {
	return {
		state,
		failureReason: state === "failed" ? "timed_out" : null,
		providerError: null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
		previewState: null,
		previewPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: true,
		errors: [],
		alreadyTerminal: false,
	};
}

/**
 * Fake `RuntimeProvider` that records the graceful-cancel target (warren-1f56).
 * The watchdog burrow-cancel rides the seam (`provider.cancel(handle)`), so the
 * test injects a provider whose `cancel` pushes the run's `providerRunId`.
 */
export function makeCancelProvider(cancels: string[]): RuntimeProvider {
	return {
		cancel: async (handle: RunHandle) => {
			cancels.push(handle.providerRunId);
		},
	} as unknown as RuntimeProvider;
}

/** A `RunStatus` with sane defaults, overridable per-field. */
export function statusOf(over: Partial<RunStatus>): RunStatus {
	return {
		phase: "running",
		exitCode: null,
		lastEventSeq: 0,
		lastEventTs: null,
		exists: true,
		...over,
	};
}

/** A provider whose `status()` returns `status` and records the probe count (warren-c433). */
export function makeStatusProvider(status: RunStatus): {
	provider: RuntimeProvider;
	statusCalls: () => number;
} {
	let calls = 0;
	const provider = {
		status: async (_handle: RunHandle): Promise<RunStatus> => {
			calls += 1;
			return status;
		},
		cancel: async () => {},
	} as unknown as RuntimeProvider;
	return { provider, statusCalls: () => calls };
}
