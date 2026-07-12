import { describe, expect, test } from "bun:test";
import { renderPrometheus } from "../../observability/prometheus.ts";
import {
	buildPodPhaseMetrics,
	METRIC_POD_PENDING_DURATION,
	METRIC_POD_PHASE,
	METRIC_WORKSPACE_INIT_DURATION,
	type PodMetricsSnapshot,
} from "./pod-metrics.ts";

describe("buildPodPhaseMetrics", () => {
	test("renders a labelled phase gauge sample per phase, name-sorted", () => {
		const snapshot: PodMetricsSnapshot = {
			phaseCounts: { Running: 5, Pending: 2, Failed: 1 },
			pendingDurationSeconds: 12,
			lastInitDurationSeconds: 3.5,
		};
		const metrics = buildPodPhaseMetrics(snapshot);
		const phase = metrics.find((m) => m.name === METRIC_POD_PHASE);
		expect(phase?.type).toBe("gauge");
		expect(phase?.samples).toEqual([
			{ labels: { phase: "Failed" }, value: 1 },
			{ labels: { phase: "Pending" }, value: 2 },
			{ labels: { phase: "Running" }, value: 5 },
		]);
	});

	test("emits the pending-duration gauge as a single unlabelled sample", () => {
		const metrics = buildPodPhaseMetrics({
			phaseCounts: { Pending: 1 },
			pendingDurationSeconds: 42,
			lastInitDurationSeconds: null,
		});
		const pending = metrics.find((m) => m.name === METRIC_POD_PENDING_DURATION);
		expect(pending?.samples).toEqual([{ value: 42 }]);
	});

	test("omits the init-duration gauge until a workspace-init has completed", () => {
		const metrics = buildPodPhaseMetrics({
			phaseCounts: {},
			pendingDurationSeconds: 0,
			lastInitDurationSeconds: null,
		});
		expect(metrics.find((m) => m.name === METRIC_WORKSPACE_INIT_DURATION)).toBeUndefined();
	});

	test("includes the init-duration gauge once one has completed", () => {
		const metrics = buildPodPhaseMetrics({
			phaseCounts: {},
			pendingDurationSeconds: 0,
			lastInitDurationSeconds: 7.25,
		});
		const init = metrics.find((m) => m.name === METRIC_WORKSPACE_INIT_DURATION);
		expect(init?.samples).toEqual([{ value: 7.25 }]);
	});

	test("an empty snapshot still renders a valid zero-series phase gauge", () => {
		const metrics = buildPodPhaseMetrics({
			phaseCounts: {},
			pendingDurationSeconds: 0,
			lastInitDurationSeconds: null,
		});
		const body = renderPrometheus(metrics);
		expect(body).toContain(`# TYPE ${METRIC_POD_PHASE} gauge`);
		// No phase samples, but the pending gauge always renders a 0.
		expect(body).toContain(`${METRIC_POD_PENDING_DURATION} 0`);
	});

	test("output round-trips through the Prometheus encoder", () => {
		const body = renderPrometheus(
			buildPodPhaseMetrics({
				phaseCounts: { Running: 3 },
				pendingDurationSeconds: 9,
				lastInitDurationSeconds: 2,
			}),
		);
		expect(body).toContain(`${METRIC_POD_PHASE}{phase="Running"} 3`);
		expect(body).toContain(`${METRIC_POD_PENDING_DURATION} 9`);
		expect(body).toContain(`${METRIC_WORKSPACE_INIT_DURATION} 2`);
	});
});
