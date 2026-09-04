import { describe, expect, test } from "bun:test";
import {
	CalibrationMetricStore,
	calibrateOnce,
	computeAgreement,
	strongJudgeModelId,
} from "./calibration.ts";
import type { JudgeFn } from "./collector.ts";
import type { JudgeOutcome, JudgmentStats } from "./judge-loop.ts";
import { SpendLedger } from "./spend-ledger.ts";
import { VerdictStore } from "./verdict-store.ts";
import type { ConfidenceBand, JudgeVerdict, VerdictClass } from "./wire.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const RUBRIC = "rubric-v1-abc";
const CHEAP = "cheap-model";
const STRONG_PROVIDER = "anthropic";
const STRONG_MODEL = "strong-model";
const STRONG_ID = strongJudgeModelId(STRONG_PROVIDER, STRONG_MODEL);

function stats(costUsd: number): JudgmentStats {
	return {
		attempts: 1,
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		costUsd,
		pagesRead: 1,
		pageCapHit: false,
	};
}

function makeVerdict(
	runId: string,
	model: string,
	assignments: ReadonlyArray<readonly [VerdictClass, ConfidenceBand]>,
	provider = "anthropic",
): JudgeVerdict {
	return {
		runId,
		assignments: assignments.map(([verdictClass, confidence]) => ({
			class: verdictClass,
			confidence,
			...(verdictClass === "clean"
				? { evidence: [] }
				: { evidence: [{ fromSeq: 1, toSeq: 2 }] }),
		})),
		provenance: {
			provider,
			model,
			rubricVersion: RUBRIC,
			judgedAt: NOW.toISOString(),
			costUsd: 0.01,
		},
	};
}

function verdictOutcome(runId: string, costUsd = 0.05): JudgeOutcome {
	return {
		kind: "verdict",
		verdict: makeVerdict(runId, STRONG_MODEL, [["spin_loop", "high"]], STRONG_PROVIDER),
		stats: stats(costUsd),
	};
}

function makeDeps(overrides?: Partial<Parameters<typeof calibrateOnce>[0]>) {
	const verdicts = new VerdictStore(":memory:", { now: () => NOW });
	const metrics = new CalibrationMetricStore(":memory:");
	const spend = new SpendLedger(":memory:");
	const judged: string[] = [];
	const judge: JudgeFn = (runId) => {
		judged.push(runId);
		return Promise.resolve(verdictOutcome(runId));
	};
	const deps: Parameters<typeof calibrateOnce>[0] = {
		verdicts,
		metrics,
		spend,
		judge,
		rubricVersion: RUBRIC,
		cheapModelId: CHEAP,
		strongProvider: STRONG_PROVIDER,
		strongModelId: STRONG_MODEL,
		sampleSize: 5,
		maxCostUsdPerJudgment: 0.25,
		dailyBudgetUsd: 5,
		now: () => NOW,
		random: () => 0,
		...overrides,
	};
	return { deps, verdicts, metrics, spend, judged };
}

function seedCheapVerdicts(verdicts: VerdictStore, runIds: string[]): void {
	for (const runId of runIds) {
		verdicts.recordVerdict(makeVerdict(runId, CHEAP, [["spin_loop", "high"]]));
	}
}

describe("strongJudgeModelId", () => {
	test("qualifies the model id with its provider", () => {
		expect(strongJudgeModelId("openai", "gpt-5")).toBe("openai/gpt-5");
	});
});

describe("computeAgreement", () => {
	const identity = { rubricVersion: RUBRIC, cheapModelId: CHEAP, strongModelId: STRONG_ID };

	test("computes exact-match band agreement per class and overall", () => {
		const verdicts = new VerdictStore(":memory:", { now: () => NOW });
		// run-1: identical maps — agrees on both classes and overall.
		verdicts.recordVerdict(makeVerdict("run-1", CHEAP, [["spin_loop", "high"]]));
		verdicts.recordVerdict(makeVerdict("run-1", STRONG_ID, [["spin_loop", "high"]]));
		// run-2: same class, different band — class disagrees, overall disagrees.
		verdicts.recordVerdict(makeVerdict("run-2", CHEAP, [["spin_loop", "low"]]));
		verdicts.recordVerdict(makeVerdict("run-2", STRONG_ID, [["spin_loop", "high"]]));
		// run-3: cheap assigns a class the strong leg omits — gate_flunk disagrees.
		verdicts.recordVerdict(
			makeVerdict("run-3", CHEAP, [
				["spin_loop", "high"],
				["gate_flunk", "medium"],
			]),
		);
		verdicts.recordVerdict(makeVerdict("run-3", STRONG_ID, [["spin_loop", "high"]]));
		const pairs = verdicts.calibrationPairs(RUBRIC, CHEAP, STRONG_ID);
		expect(pairs).toHaveLength(3);

		const report = computeAgreement(pairs, identity, () => NOW);
		expect(report.sampledPairs).toBe(3);
		// spin_loop: 3 compared, 2 agreed (run-2 mismatched on band).
		expect(report.perClass.spin_loop).toEqual({ compared: 3, agreed: 2, rate: 2 / 3 });
		// gate_flunk: 1 compared (one-sided assignment), 0 agreed.
		expect(report.perClass.gate_flunk).toEqual({ compared: 1, agreed: 0, rate: 0 });
		// clean: never assigned by either leg — no denominator, null rate.
		expect(report.perClass.clean).toEqual({ compared: 0, agreed: 0, rate: null });
		// overall: only run-1's full class→band map matches exactly.
		expect(report.overallAgreed).toBe(1);
		expect(report.overallRate).toBe(1 / 3);
		verdicts.close();
	});

	test("returns null rates when no pairs exist", () => {
		const report = computeAgreement([], identity, () => NOW);
		expect(report.sampledPairs).toBe(0);
		expect(report.overallRate).toBeNull();
		expect(report.perClass.spin_loop.rate).toBeNull();
	});
});

describe("CalibrationMetricStore", () => {
	test("round-trips the latest report per rubric version", () => {
		const metrics = new CalibrationMetricStore(":memory:");
		const identity = { rubricVersion: RUBRIC, cheapModelId: CHEAP, strongModelId: STRONG_ID };
		const first = computeAgreement([], identity, () => NOW);
		metrics.record(first);
		const second = computeAgreement([], identity, () => new Date("2026-08-15T18:00:00.000Z"));
		metrics.record(second);

		const latest = metrics.latestForRubric(RUBRIC);
		expect(latest?.computedAt).toBe("2026-08-15T18:00:00.000Z");
		expect(metrics.historyForRubric(RUBRIC, 10)).toHaveLength(2);
		expect(metrics.latestForRubric("rubric-v2-other")).toBeNull();
		metrics.close();
	});
});

describe("calibrateOnce", () => {
	test("appends strong verdicts under the same rubric version without touching cheap ones", async () => {
		const { deps, verdicts } = makeDeps();
		seedCheapVerdicts(verdicts, ["run-1", "run-2"]);

		const result = await calibrateOnce(deps);
		expect(result.rejudged).toBe(2);

		const run1 = verdicts.rowsForRun("run-1");
		expect(run1).toHaveLength(2);
		expect(run1[0]?.judgeModelId).toBe(CHEAP);
		expect(run1[1]?.judgeModelId).toBe(STRONG_ID);
		expect(run1[1]?.rubricVersion).toBe(RUBRIC);
		verdicts.close();
	});

	test("samples at most sampleSize runs from the cheap-judged candidates", async () => {
		const { deps, judged } = makeDeps({ sampleSize: 3 });
		seedCheapVerdicts(deps.verdicts, ["run-1", "run-2", "run-3", "run-4", "run-5"]);

		const result = await calibrateOnce(deps);
		expect(result.candidates).toBe(5);
		expect(result.sampled).toBe(3);
		expect(judged).toHaveLength(3);
		deps.verdicts.close();
	});

	test("draws the sample from the entropy source, not from the sorted head", async () => {
		// random() → just under 1 always picks the LAST remaining candidate.
		// The pre-fix shuffle pushed the element that used to sit at slot i,
		// which is candidates[i] regardless of the draw — so every pass took
		// the first sampleSize ids in sorted order.
		const { deps, judged } = makeDeps({ sampleSize: 3, random: () => 0.999 });
		seedCheapVerdicts(deps.verdicts, ["run-1", "run-2", "run-3", "run-4", "run-5"]);

		await calibrateOnce(deps);
		expect(judged[0]).toBe("run-5");
		expect(new Set(judged).size).toBe(3);
		expect(judged).not.toEqual(["run-1", "run-2", "run-3"]);
		deps.verdicts.close();
	});

	test("excludes runs the strong model already resolved, verdict or marker", async () => {
		const { deps, judged } = makeDeps();
		seedCheapVerdicts(deps.verdicts, ["run-1", "run-2", "run-3"]);
		deps.verdicts.recordVerdict(makeVerdict("run-1", STRONG_ID, [["clean", "high"]]));
		deps.verdicts.recordUnjudged({
			runId: "run-2",
			rubricVersion: RUBRIC,
			judgeModelId: STRONG_ID,
			reason: "budget_exceeded",
		});

		const result = await calibrateOnce(deps);
		expect(result.candidates).toBe(1);
		expect(judged).toEqual(["run-3"]);
		deps.verdicts.close();
	});

	test("an exhausted daily budget defers the sampled run — no marker, announced once", async () => {
		const { deps, verdicts, judged } = makeDeps({ dailyBudgetUsd: 0 });
		seedCheapVerdicts(verdicts, ["run-1", "run-2"]);
		const deferrals: string[] = [];

		const result = await calibrateOnce({
			...deps,
			onBudgetDeferred: (runId) => deferrals.push(runId),
		});
		expect(result.budgetDeferred).toBe(2);
		expect(result.rejudged).toBe(0);
		expect(judged).toHaveLength(0);
		// Announced once per pass, not once per deferred run.
		expect(deferrals).toHaveLength(1);

		// No marker: a budget_exceeded row under the strong id would occupy
		// the dedupe key and permanently exclude the run from every future
		// sample (PR #969 semantics). Both runs stay candidates.
		for (const runId of ["run-1", "run-2"]) {
			expect(verdicts.rowsForRun(runId)).toHaveLength(1);
		}
		const rerun = await calibrateOnce({ ...deps, dailyBudgetUsd: 5 });
		expect(rerun.candidates).toBe(2);
		expect(rerun.rejudged).toBe(2);
		verdicts.close();
	});

	test("ledgers calibration spend against the shared daily budget", async () => {
		const { deps, spend } = makeDeps();
		seedCheapVerdicts(deps.verdicts, ["run-1"]);

		await calibrateOnce(deps);
		expect(spend.spendForDay("2026-08-15")).toBeCloseTo(0.05);
		deps.verdicts.close();
	});

	test("records unjudged markers for judge-reported failures and ledgers the spend", async () => {
		const judge: JudgeFn = () =>
			Promise.resolve({
				kind: "unjudged",
				reason: "judge_error",
				detail: "provider 500",
				stats: stats(0.02),
			});
		const { deps, verdicts, spend } = makeDeps({ judge });
		seedCheapVerdicts(verdicts, ["run-1"]);

		const result = await calibrateOnce(deps);
		expect(result.rejudged).toBe(1);
		expect(verdicts.rowsForRun("run-1")[1]).toMatchObject({
			kind: "unjudged",
			judgeModelId: STRONG_ID,
			reason: "judge_error",
			detail: "provider 500",
		});
		expect(spend.spendForDay("2026-08-15")).toBeCloseTo(0.02);
		verdicts.close();
	});

	test("a $0 failure is skipped, not marked, and the run is re-drawn next pass", async () => {
		const judge: JudgeFn = () =>
			Promise.resolve({
				kind: "unjudged",
				reason: "judge_error",
				detail: "401 invalid x-api-key",
				stats: stats(0),
			});
		const { deps, verdicts, spend } = makeDeps({ judge });
		seedCheapVerdicts(verdicts, ["run-1"]);
		const skips: string[] = [];

		const result = await calibrateOnce({ ...deps, onZeroCostSkipped: (runId) => skips.push(runId) });
		expect(result.zeroCostSkipped).toBe(1);
		expect(result.rejudged).toBe(0);
		expect(skips).toEqual(["run-1"]);
		// Only the cheap verdict seeded above: no strong-judge row took the
		// dedupe key, so the run is still a candidate.
		expect(verdicts.rowsForRun("run-1")).toHaveLength(1);
		expect(spend.spendForDay("2026-08-15")).toBeCloseTo(0);

		const rerun = await calibrateOnce(deps);
		expect(rerun.candidates).toBe(1);
		verdicts.close();
	});

	test("persists the agreement report as a queryable per-rubric-version metric", async () => {
		const { deps, verdicts, metrics } = makeDeps();
		seedCheapVerdicts(verdicts, ["run-1", "run-2"]);

		const result = await calibrateOnce(deps);
		// The stubbed strong judge agrees with the cheap seed on every run.
		expect(result.report.sampledPairs).toBe(2);
		expect(result.report.overallRate).toBe(1);

		const stored = metrics.latestForRubric(RUBRIC);
		expect(stored).not.toBeNull();
		expect(stored?.sampledPairs).toBe(2);
		expect(stored?.overallRate).toBe(1);
		expect(stored?.strongModelId).toBe(STRONG_ID);
		verdicts.close();
		metrics.close();
	});

	test("a replayed pass over the same sample is an exact no-op", async () => {
		const { deps, verdicts } = makeDeps();
		seedCheapVerdicts(verdicts, ["run-1"]);

		await calibrateOnce(deps);
		const countAfterFirst = verdicts.count();
		const result = await calibrateOnce(deps);
		expect(result.candidates).toBe(0);
		expect(result.rejudged).toBe(0);
		expect(verdicts.count()).toBe(countAfterFirst);
		verdicts.close();
	});
});
