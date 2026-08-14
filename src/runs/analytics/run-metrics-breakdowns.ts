/**
 * Secondary run-metrics breakdowns (split out of `run-metrics.ts` under the
 * 500-line file budget when warren-bd57 added the landed-work rollup).
 *
 * Holds the `byFailureReason` and `topSeedsByContext` builders plus their
 * bucket types. Both are single-pass Map rollups over the flat
 * `RunMetricsRow` list, sorted by their primary metric descending with
 * deterministic tie-breaks, exactly like the group breakdowns in the main
 * module.
 */

import { contextTokensOf, NONE_KEY, type RunMetricsRow } from "./run-metrics.ts";

export interface FailureBucket {
	readonly key: string;
	readonly runs: number;
}

export interface SeedContextBucket {
	readonly seedId: string;
	readonly runs: number;
	readonly contextTokensTotal: number;
	readonly avgContextTokens: number | null;
}

export function buildFailureReasons(rows: readonly RunMetricsRow[]): FailureBucket[] {
	const acc = new Map<string, number>();
	for (const r of rows) {
		if (r.state !== "failed") continue;
		const key = r.failureReason ?? NONE_KEY;
		acc.set(key, (acc.get(key) ?? 0) + 1);
	}
	const out: FailureBucket[] = [];
	for (const [key, runs] of acc) out.push({ key, runs });
	out.sort((a, b) => {
		if (b.runs !== a.runs) return b.runs - a.runs;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return out;
}

export function buildTopSeeds(rows: readonly RunMetricsRow[]): SeedContextBucket[] {
	const acc = new Map<string, { runs: number; total: number; count: number }>();
	for (const r of rows) {
		if (r.seedId === null) continue; // seed-originated runs only (risk #4)
		let s = acc.get(r.seedId);
		if (s === undefined) {
			s = { runs: 0, total: 0, count: 0 };
			acc.set(r.seedId, s);
		}
		s.runs += 1;
		const ctx = contextTokensOf(r);
		if (ctx !== null) {
			s.total += ctx;
			s.count += 1;
		}
	}
	const out: SeedContextBucket[] = [];
	for (const [seedId, s] of acc) {
		out.push({
			seedId,
			runs: s.runs,
			contextTokensTotal: s.total,
			avgContextTokens: s.count === 0 ? null : s.total / s.count,
		});
	}
	out.sort((a, b) => {
		if (b.contextTokensTotal !== a.contextTokensTotal) {
			return b.contextTokensTotal - a.contextTokensTotal;
		}
		if (b.runs !== a.runs) return b.runs - a.runs;
		return a.seedId < b.seedId ? -1 : a.seedId > b.seedId ? 1 : 0;
	});
	return out;
}
