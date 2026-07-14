import { describe, expect, test } from "bun:test";
import type { FinalizeIntent, FinalizeResult, RunHandle, RunStatus } from "../contract.ts";
import {
	failedFinalizeResult,
	finalizeK8sRun,
	type K8sFinalizeDeps,
	toInPodIntent,
} from "./finalize.ts";
import { FinalizeCoordinator } from "./finalize-coordinator.ts";

const HANDLE: RunHandle = { runId: "run_fin", sandboxId: "run-run-fin", providerRunId: "uid-1" };

function intent(over: Partial<FinalizeIntent> = {}): FinalizeIntent {
	return {
		branch: "warren/run_fin",
		push: true,
		mirror: ["mulch", "seeds", "plans", "plot"],
		commit: ["plot", "seeds"],
		baseBranch: "main",
		projectClonePathHint: "/data/projects/x",
		...over,
	};
}

function podResult(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 3,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "seeds.closed", payload: { id: "warren-1" } }],
		mirror: {
			seeds: { version: 1, closed: 1, created: 0, path: ".seeds/issues.jsonl", mergedBody: "x" },
		},
		prBranch: "warren/run_fin",
		stages: [{ stage: "branch_push", status: "ok" }],
	};
}

const alive: RunStatus = {
	phase: "running",
	exitCode: null,
	lastEventSeq: 0,
	lastEventTs: null,
	exists: true,
};
const gone: RunStatus = {
	phase: "failed",
	exitCode: null,
	terminalReason: "lost",
	lastEventSeq: 0,
	lastEventTs: null,
	exists: false,
};
/** Terminal phase but pod still PRESENT (crashed/Failed, not yet GC'd). */
const terminalPresent: RunStatus = {
	phase: "failed",
	exitCode: 1,
	terminalReason: "error",
	lastEventSeq: 0,
	lastEventTs: null,
	exists: true,
};

/** A setTimer that fires callbacks scheduled at exactly `fireMs`, no-ops others. */
function firingTimer(fireMs: number): K8sFinalizeDeps["setTimer"] {
	return (fn, ms) => {
		if (ms === fireMs) queueMicrotask(fn);
		return { cancel: () => {} };
	};
}

/** A setTimer that never fires — only the result promise can settle the race. */
const inertTimer: K8sFinalizeDeps["setTimer"] = () => ({ cancel: () => {} });

describe("toInPodIntent", () => {
	test("drops the host clone hint and attaches the git token", () => {
		const wire = toInPodIntent(intent(), "ghp_secret");
		expect("projectClonePathHint" in wire).toBe(false);
		expect(wire.gitToken).toBe("ghp_secret");
		expect(wire.branch).toBe("warren/run_fin");
		expect(wire.mirror).toEqual(["mulch", "seeds", "plans", "plot"]);
		expect(wire.commit).toEqual(["plot", "seeds"]);
		expect(wire.baseBranch).toBe("main");
	});

	test("omits the token when absent and defaults commit from mirror (plot/seeds only)", () => {
		const wire = toInPodIntent(intent({ commit: undefined }), undefined);
		expect("gitToken" in wire).toBe(false);
		// mulch/plans must NOT leak into the commit list.
		expect(wire.commit).toEqual(["seeds", "plot"]);
	});
});

describe("failedFinalizeResult", () => {
	test("marks every requested stage failed with the message, nothing pushed", () => {
		const r = failedFinalizeResult(intent(), "boom");
		expect(r.pushed).toBe(false);
		expect(r.commitsAhead).toBeNull();
		expect(r.mirror).toEqual({});
		expect(r.events).toEqual([
			{ kind: "reap_failed", payload: { step: "finalize", message: "boom" } },
		]);
		const failed = r.stages.filter((s) => s.status === "failed").map((s) => s.stage);
		expect(failed).toEqual([
			"mulch_merge",
			"seeds_mirror",
			"plans_mirror",
			"plot_merge",
			"plot_commit",
			"seeds_commit",
			"branch_push",
		]);
	});
});

describe("finalizeK8sRun", () => {
	test("returns the in-pod result once the pod POSTs it", async () => {
		const coordinator = new FinalizeCoordinator();
		const deps: K8sFinalizeDeps = {
			coordinator,
			status: async () => alive,
			setTimer: inertTimer,
		};
		const p = finalizeK8sRun(HANDLE, intent(), deps);
		// Let register() park the intent, then simulate the pod's result POST.
		await Promise.resolve();
		const parked = coordinator.peekIntent(HANDLE.runId);
		expect(parked).toBeDefined();
		expect(coordinator.submit(HANDLE.runId, parked?.attemptId ?? "", podResult())).toBe("accepted");

		const res = await p;
		expect(res).toEqual(podResult());
		// The pending entry is cleaned up.
		expect(coordinator.pendingCount).toBe(0);
	});

	test("degrades to a failed result on timeout", async () => {
		const coordinator = new FinalizeCoordinator();
		const res = await finalizeK8sRun(HANDLE, intent(), {
			coordinator,
			status: async () => alive,
			timeoutMs: 5_000,
			setTimer: firingTimer(5_000),
		});
		expect(res.pushed).toBe(false);
		expect(res.stages.every((s) => s.status === "failed")).toBe(true);
		expect(res.events[0]?.kind).toBe("reap_failed");
		expect((res.events[0]?.payload as { message: string }).message).toContain("timed out");
		expect(coordinator.pendingCount).toBe(0);
	});

	test("degrades to a failed result when the pod is gone", async () => {
		const coordinator = new FinalizeCoordinator();
		const res = await finalizeK8sRun(HANDLE, intent(), {
			coordinator,
			status: async () => gone,
			podPollMs: 1_000,
			timeoutMs: 999_999,
			setTimer: firingTimer(1_000),
		});
		expect(res.pushed).toBe(false);
		expect((res.events[0]?.payload as { message: string }).message).toContain("pod is gone");
		expect(coordinator.pendingCount).toBe(0);
	});

	test("degrades to a failed result when the pod is terminal but still present (no POST)", async () => {
		// warren-fd08: a crashed pod (Failed phase, not yet GC'd so `exists:true`) can
		// no longer run the in-pod finalize-entrypoint. The probe must fast-fail on the
		// terminal phase rather than waiting the full wall-clock timeout.
		const coordinator = new FinalizeCoordinator();
		const res = await finalizeK8sRun(HANDLE, intent(), {
			coordinator,
			status: async () => terminalPresent,
			podPollMs: 1_000,
			timeoutMs: 999_999, // would hang ~forever if terminal weren't fast-failed
			setTimer: firingTimer(1_000),
		});
		expect(res.pushed).toBe(false);
		expect(res.stages.every((s) => s.status === "failed")).toBe(true);
		expect((res.events[0]?.payload as { message: string }).message).toContain("terminal phase");
		expect(coordinator.pendingCount).toBe(0);
	});

	test("the result wins even if a pod-gone probe is scheduled", async () => {
		const coordinator = new FinalizeCoordinator();
		// status would say gone, but the result POST lands first via the inert timer
		// (the probe never fires), proving the result short-circuits the race.
		const deps: K8sFinalizeDeps = {
			coordinator,
			status: async () => gone,
			setTimer: inertTimer,
		};
		const p = finalizeK8sRun(HANDLE, intent(), deps);
		await Promise.resolve();
		const parked = coordinator.peekIntent(HANDLE.runId);
		coordinator.submit(HANDLE.runId, parked?.attemptId ?? "", podResult());
		await expect(p).resolves.toMatchObject({ pushed: true });
	});
});
