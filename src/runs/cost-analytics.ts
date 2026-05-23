/**
 * Cost analytics aggregator (warren-cf63 / pl-b0c0 step 6).
 *
 * Pure function that takes a flat list of "analytics rows" — one per
 * `runs` row, with the columns the aggregator actually needs plus a
 * `provider` / `model` pair already extracted from
 * `renderedAgentJson.frontmatter` and a `planId` already resolved via
 * the `plan_run_children → plan_runs` join — and emits eight grouped
 * breakdowns: by date, project, plan, plot, run, agent, model,
 * provider.
 *
 * Each breakdown bucket carries:
 *   - `key`: the group identifier (date string, projectId, planId, …)
 *   - `costUsd`: sum of `costUsd` across rows in the bucket (treats null
 *     as 0, mirroring the NULLS-aware rollup in RunsRepo.aggregate per
 *     mx-2ae43b)
 *   - `runs`: total rows in the bucket
 *   - `priced`: rows whose `costUsd` was non-null — the UI surfaces the
 *     `priced / runs` ratio so a small total isn't misread as cheap when
 *     the gap is actually unpriced ghost runs.
 *
 * Buckets are emitted sorted by `costUsd` descending, with ties broken
 * by `runs` descending and then `key` ascending — deterministic for
 * tests. The `date` breakdown is sorted by key ascending (chronological)
 * instead so the UI can render a left-to-right time series without a
 * client-side resort.
 *
 * Rows whose group key is null (e.g. `plotId === null`, no plan join)
 * are folded into a single `__none__` bucket per breakdown — see
 * `NONE_KEY`. The UI renders this as an em-dash so the operator can
 * still see how much spend is unattributed to that dimension.
 */

export const NONE_KEY = "__none__";

export interface CostAnalyticsRow {
	readonly runId: string;
	readonly projectId: string | null;
	readonly agentName: string;
	readonly plotId: string | null;
	readonly planId: string | null;
	readonly planRunId: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	readonly costUsd: number | null;
	readonly startedAt: string | null;
}

export interface CostBucket {
	readonly key: string;
	readonly costUsd: number;
	readonly runs: number;
	readonly priced: number;
}

export type Dimension =
	| "date"
	| "project"
	| "plan"
	| "plot"
	| "run"
	| "agent"
	| "model"
	| "provider";

export interface CostAnalytics {
	readonly totals: {
		readonly runs: number;
		readonly priced: number;
		readonly costUsd: number;
	};
	readonly breakdowns: Readonly<Record<Dimension, readonly CostBucket[]>>;
}

const DIMENSIONS: readonly Dimension[] = [
	"date",
	"project",
	"plan",
	"plot",
	"run",
	"agent",
	"model",
	"provider",
];

/**
 * Build all eight breakdowns from `rows`. O(rows × dimensions) — a
 * single pass per dimension over the input. For the V1 default page
 * size (last 30 days, typically a few hundred runs on a busy install)
 * this is microseconds; if installs ever push tens of thousands of runs
 * per window we can fold the eight passes into one and emit Maps.
 */
export function buildCostAnalytics(rows: readonly CostAnalyticsRow[]): CostAnalytics {
	const totals = { runs: 0, priced: 0, costUsd: 0 };
	for (const r of rows) {
		totals.runs += 1;
		if (r.costUsd !== null) {
			totals.priced += 1;
			totals.costUsd += r.costUsd;
		}
	}
	const breakdowns = {} as Record<Dimension, readonly CostBucket[]>;
	for (const dim of DIMENSIONS) {
		breakdowns[dim] = bucketsFor(rows, dim);
	}
	return { totals, breakdowns };
}

function bucketsFor(rows: readonly CostAnalyticsRow[], dim: Dimension): readonly CostBucket[] {
	const acc = new Map<string, { costUsd: number; runs: number; priced: number }>();
	for (const r of rows) {
		const key = keyFor(r, dim) ?? NONE_KEY;
		const bucket = acc.get(key);
		const costDelta = r.costUsd ?? 0;
		const pricedDelta = r.costUsd !== null ? 1 : 0;
		if (bucket === undefined) {
			acc.set(key, { costUsd: costDelta, runs: 1, priced: pricedDelta });
		} else {
			bucket.costUsd += costDelta;
			bucket.runs += 1;
			bucket.priced += pricedDelta;
		}
	}
	const out: CostBucket[] = [];
	for (const [key, v] of acc) {
		out.push({ key, costUsd: v.costUsd, runs: v.runs, priced: v.priced });
	}
	if (dim === "date") {
		// Chronological — UI renders a time series left → right. The
		// NONE_KEY bucket (runs with no startedAt) sorts last so the
		// chronological axis isn't anchored to an unknown date.
		out.sort((a, b) => {
			if (a.key === NONE_KEY && b.key === NONE_KEY) return 0;
			if (a.key === NONE_KEY) return 1;
			if (b.key === NONE_KEY) return -1;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
	} else {
		// Cost-first — operators care about "what's expensive". Ties
		// broken by run count, then key ascending for determinism.
		out.sort((a, b) => {
			if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
			if (b.runs !== a.runs) return b.runs - a.runs;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
	}
	return out;
}

function keyFor(r: CostAnalyticsRow, dim: Dimension): string | null {
	switch (dim) {
		case "date":
			return r.startedAt === null ? null : r.startedAt.slice(0, 10);
		case "project":
			return r.projectId;
		case "plan":
			return r.planId;
		case "plot":
			return r.plotId;
		case "run":
			return r.runId;
		case "agent":
			return r.agentName;
		case "model":
			return r.model;
		case "provider":
			return r.provider;
	}
}
