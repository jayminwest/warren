/**
 * `GET /metrics` — Prometheus exposition endpoint (warren observability
 * Phase 1).
 *
 * Bearer-gated like the rest of the API (warren-682a): behind a public
 * Ingress the scrape surface leaks operational shape (run counts, pod
 * phases, queue depth), so the historical Fly-era auth exemption is gone.
 * In-cluster Prometheus sends the control-plane token via the
 * ServiceMonitor's `authorization.credentials`
 * (deploy/k8s/servicemonitor.yaml).
 *
 * Two sources, assembled per scrape:
 *   - **Gauges** read live from SQLite (`countRunsByState` / `aggregateRunCost`,
 *     the same aggregates the periodic `ops.stats` log line uses) + the live
 *     bridge-registry size. No state of its own.
 *   - **Counters** from the in-process `MetricsRegistry` (log-line rates by
 *     level, fed by the pino sink). Absent registry → counters omitted.
 *
 * When `deps.db` is unwired (tests), the DB gauges are skipped and only the
 * bridge gauge + any counters render, so the endpoint never throws.
 */

import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { aggregateRunCost, countRunsByState } from "../../db/repos/runs-stats.ts";
import type { CounterSnapshot } from "../../observability/metrics-registry.ts";
import {
	PROMETHEUS_CONTENT_TYPE,
	type PromMetric,
	renderPrometheus,
} from "../../observability/prometheus.ts";
import { buildPodPhaseMetrics } from "../../runtime/k8s/pod-metrics.ts";
import { textResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

export function metricsHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		const metrics: PromMetric[] = [];

		if (deps.db !== undefined) {
			const adapter = DrizzleAdapter.for(deps.db);
			const [byState, cost] = await Promise.all([
				countRunsByState(adapter),
				aggregateRunCost(adapter),
			]);
			metrics.push({
				name: "warren_runs",
				help: "Run count grouped by lifecycle state.",
				type: "gauge",
				samples: Object.entries(byState).map(([state, value]) => ({ labels: { state }, value })),
			});
			metrics.push(gauge("warren_cost_usd", "Cumulative agent cost in USD.", cost.costUsd));
			metrics.push(gauge("warren_tokens_input", "Cumulative input tokens.", cost.tokensInput));
			metrics.push(gauge("warren_tokens_output", "Cumulative output tokens.", cost.tokensOutput));
		}

		metrics.push(
			gauge("warren_active_bridges", "Currently-attached run-stream bridges.", deps.bridges.size()),
		);

		if (deps.podMetrics !== undefined) {
			// K8s pod-phase gauges, read live from the pod-watcher cache at scrape
			// (pl-829f step 16). Absent under LocalProvider — nothing appended.
			metrics.push(...buildPodPhaseMetrics(deps.podMetrics.metricsSnapshot()));
		}

		if (deps.metricsRegistry !== undefined) {
			metrics.push(...countersToMetrics(deps.metricsRegistry.snapshot()));
		}

		return textResponse(200, renderPrometheus(metrics), PROMETHEUS_CONTENT_TYPE);
	};
}

function gauge(name: string, help: string, value: number): PromMetric {
	return { name, help, type: "gauge", samples: [{ value }] };
}

function countersToMetrics(snapshots: readonly CounterSnapshot[]): PromMetric[] {
	const samplesByName = new Map<
		string,
		{ labels: Readonly<Record<string, string>>; value: number }[]
	>();
	const order: string[] = [];
	for (const snap of snapshots) {
		let samples = samplesByName.get(snap.name);
		if (samples === undefined) {
			samples = [];
			samplesByName.set(snap.name, samples);
			order.push(snap.name);
		}
		samples.push({ labels: snap.labels, value: snap.value });
	}
	return order.map((name) => ({
		name,
		help: `Warren counter ${name}.`,
		type: "counter",
		samples: samplesByName.get(name) ?? [],
	}));
}
