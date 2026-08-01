import { describe, expect, test } from "bun:test";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { defaultFetchRunState } from "./run.ts";

/**
 * Minimal RuntimeProvider stub (warren-11cc), mirroring the one in
 * `run.test.ts`. Only `status()` is wired — `defaultFetchRunState` never
 * touches the other methods.
 */
function fakeProvider(): RuntimeProvider {
	const notWired = () => {
		throw new Error("fakeProvider: method not wired for this test");
	};
	return {
		capabilities: {
			previewPorts: false,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		},
		create: notWired as never,
		streamEvents: notWired as never,
		status: notWired as never,
		sendMessage: notWired as never,
		cancel: notWired as never,
		workspaceInfo: notWired as never,
		finalize: notWired as never,
		terminate: notWired as never,
	};
}

describe("defaultFetchRunState", () => {
	const handle = { runId: "r1", sandboxId: "bur_x", providerRunId: "run_x" };
	const instantSleep = async () => undefined;

	function providerWithPhases(phases: string[]): RuntimeProvider {
		let calls = 0;
		return {
			...fakeProvider(),
			status: (async () => {
				const phase = phases[Math.min(calls, phases.length - 1)];
				calls++;
				return { phase, exitCode: null, lastEventSeq: 0, lastEventTs: null, exists: true };
			}) as never,
		};
	}

	test("returns the terminal phase on the first probe", async () => {
		const fetch = defaultFetchRunState(providerWithPhases(["succeeded"]), {
			sleep: instantSleep,
		});
		expect(await fetch(handle)).toBe("succeeded");
	});

	test("retries while the phase is running and returns the terminal phase once burrow finalizes", async () => {
		// warren-2909 / GH #663: the result envelope lands while burrow still
		// reports `running`; a bounded retry must ride out the finalize lag
		// instead of mapping the first non-terminal read to failed.
		const provider = providerWithPhases(["running", "running", "succeeded"]);
		const fetch = defaultFetchRunState(provider, {
			pollMs: 10,
			timeoutMs: 1000,
			sleep: instantSleep,
		});
		expect(await fetch(handle)).toBe("succeeded");
	});

	test("maps a run that stays running past the retry budget to failed", async () => {
		const provider = providerWithPhases(["running"]);
		const fetch = defaultFetchRunState(provider, {
			pollMs: 10,
			timeoutMs: 30,
			sleep: instantSleep,
		});
		expect(await fetch(handle)).toBe("failed");
	});

	test("returns failed or cancelled phases without retrying", async () => {
		for (const phase of ["failed", "cancelled"] as const) {
			const provider = providerWithPhases([phase, "succeeded"]);
			const fetch = defaultFetchRunState(provider, {
				pollMs: 10,
				timeoutMs: 1000,
				sleep: instantSleep,
			});
			expect(await fetch(handle)).toBe(phase);
		}
	});
});
