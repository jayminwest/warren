import { describe, expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import {
	type AdmissionCaps,
	admissionDisabled,
	countPodsForAdmission,
	DEFAULT_MAX_PENDING_PODS,
	DEFAULT_MAX_QUEUE_DEPTH,
	evaluateAdmission,
	resolveAdmissionCaps,
} from "./admission.ts";
import { LABEL_PROJECT } from "./pod-spec.ts";

const UNLIMITED: AdmissionCaps = {
	maxQueueDepth: 0,
	maxPendingPods: 0,
	maxProjectConcurrency: null,
};

function pod(phase: string, projectId?: string): V1Pod {
	return {
		status: { phase },
		metadata: projectId !== undefined ? { labels: { [LABEL_PROJECT]: projectId } } : {},
	};
}

describe("resolveAdmissionCaps", () => {
	test("defaults when env is empty and no project override", () => {
		expect(resolveAdmissionCaps({})).toEqual({
			maxQueueDepth: DEFAULT_MAX_QUEUE_DEPTH,
			maxPendingPods: DEFAULT_MAX_PENDING_PODS,
			maxProjectConcurrency: null,
		});
	});

	test("reads global env knobs, ignoring blank / non-numeric / negative values", () => {
		expect(resolveAdmissionCaps({ WARREN_K8S_MAX_QUEUE_DEPTH: "100" }).maxQueueDepth).toBe(100);
		expect(resolveAdmissionCaps({ WARREN_K8S_MAX_PENDING_PODS: "5" }).maxPendingPods).toBe(5);
		// 0 is meaningful (disable), not "unset".
		expect(resolveAdmissionCaps({ WARREN_K8S_MAX_QUEUE_DEPTH: "0" }).maxQueueDepth).toBe(0);
		// Junk falls back to the default.
		expect(resolveAdmissionCaps({ WARREN_K8S_MAX_QUEUE_DEPTH: "abc" }).maxQueueDepth).toBe(
			DEFAULT_MAX_QUEUE_DEPTH,
		);
		expect(resolveAdmissionCaps({ WARREN_K8S_MAX_PENDING_PODS: "-3" }).maxPendingPods).toBe(
			DEFAULT_MAX_PENDING_PODS,
		);
	});

	test("per-project override wins over the global project-concurrency default", () => {
		expect(
			resolveAdmissionCaps({ WARREN_K8S_MAX_PROJECT_CONCURRENCY: "10" }, 3).maxProjectConcurrency,
		).toBe(3);
	});

	test("falls back to the global project-concurrency default when no override", () => {
		expect(
			resolveAdmissionCaps({ WARREN_K8S_MAX_PROJECT_CONCURRENCY: "8" }).maxProjectConcurrency,
		).toBe(8);
	});

	test("a non-positive project override falls back to the global default (else null)", () => {
		expect(resolveAdmissionCaps({}, 0).maxProjectConcurrency).toBeNull();
		expect(
			resolveAdmissionCaps({ WARREN_K8S_MAX_PROJECT_CONCURRENCY: "4" }, 0).maxProjectConcurrency,
		).toBe(4);
	});
});

describe("admissionDisabled", () => {
	test("true only when every cap is unlimited", () => {
		expect(admissionDisabled(UNLIMITED)).toBe(true);
		expect(admissionDisabled({ ...UNLIMITED, maxPendingPods: 1 })).toBe(false);
		expect(admissionDisabled({ ...UNLIMITED, maxQueueDepth: 1 })).toBe(false);
		expect(admissionDisabled({ ...UNLIMITED, maxProjectConcurrency: 1 })).toBe(false);
	});
});

describe("countPodsForAdmission", () => {
	test("counts non-terminal + pending + per-project, ignoring terminal phases", () => {
		const pods = [
			pod("Pending", "p1"),
			pod("Running", "p1"),
			pod("Running", "p2"),
			pod("Succeeded", "p1"),
			pod("Failed", "p1"),
			pod("Unknown", "p2"),
		];
		expect(countPodsForAdmission(pods, "p1", LABEL_PROJECT)).toEqual({
			nonTerminalPods: 4, // Pending + 2 Running + Unknown
			pendingPods: 1,
			projectNonTerminalPods: 2, // p1 Pending + p1 Running (terminals excluded)
		});
	});

	test("a pod with no phase counts as non-terminal (conservative)", () => {
		const noPhase: V1Pod = { status: {}, metadata: {} };
		const counts = countPodsForAdmission([noPhase], undefined, LABEL_PROJECT);
		expect(counts.nonTerminalPods).toBe(1);
		expect(counts.pendingPods).toBe(1); // defaults to Pending
	});

	test("no project filter (undefined) yields zero project count", () => {
		const counts = countPodsForAdmission([pod("Running", "p1")], undefined, LABEL_PROJECT);
		expect(counts.projectNonTerminalPods).toBe(0);
		expect(counts.nonTerminalPods).toBe(1);
	});
});

describe("evaluateAdmission", () => {
	const caps: AdmissionCaps = { maxQueueDepth: 50, maxPendingPods: 20, maxProjectConcurrency: 5 };

	test("admits when every count is under its cap", () => {
		expect(
			evaluateAdmission({ nonTerminalPods: 10, pendingPods: 3, projectNonTerminalPods: 2 }, caps),
		).toEqual({ admit: true });
	});

	test("per-project cap is checked first (most specific reason wins)", () => {
		// project + pending BOTH exceeded → project reason reported.
		const decision = evaluateAdmission(
			{ nonTerminalPods: 40, pendingPods: 20, projectNonTerminalPods: 5 },
			caps,
		);
		expect(decision.admit).toBe(false);
		if (!decision.admit) expect(decision.reason).toBe("project_concurrency_exceeded");
	});

	test("pending saturation before queue depth", () => {
		const decision = evaluateAdmission(
			{ nonTerminalPods: 50, pendingPods: 20, projectNonTerminalPods: 0 },
			caps,
		);
		if (!decision.admit) expect(decision.reason).toBe("cluster_pending_saturated");
	});

	test("queue depth trips when only the total is at the cap", () => {
		const decision = evaluateAdmission(
			{ nonTerminalPods: 50, pendingPods: 1, projectNonTerminalPods: 0 },
			caps,
		);
		if (!decision.admit) {
			expect(decision.reason).toBe("queue_depth_exceeded");
			expect(decision.retryAfterSeconds).toBe(30);
			expect(decision.detail).toContain("queue-depth cap 50");
		}
	});

	test("a cap of 0 / null is unlimited and skipped", () => {
		expect(
			evaluateAdmission(
				{ nonTerminalPods: 999, pendingPods: 999, projectNonTerminalPods: 999 },
				UNLIMITED,
			),
		).toEqual({ admit: true });
	});

	test("the cap is inclusive: count == cap rejects", () => {
		const decision = evaluateAdmission(
			{ nonTerminalPods: 5, pendingPods: 0, projectNonTerminalPods: 0 },
			{ maxQueueDepth: 5, maxPendingPods: 0, maxProjectConcurrency: null },
		);
		expect(decision.admit).toBe(false);
	});
});
