import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { collectOnce, type JudgeFn, runJudgeCollector } from "./collector.ts";
import { JudgmentCursorStore } from "./cursor-store.ts";
import { FakeWarren } from "./fake-warren.ts";
import type { JudgeOutcome, JudgmentStats } from "./judge-loop.ts";
import { SpendLedger } from "./spend-ledger.ts";
import { VerdictStore } from "./verdict-store.ts";
import { validateVerdict } from "./wire.ts";

const RUBRIC_V1 = "sha256:" + "ab".repeat(32);
const RUBRIC_V2 = "sha256:" + "cd".repeat(32);
const MODEL = "claude-haiku-4-5";
const NOW = new Date("2026-08-15T17:00:00.000Z");

function stats(costUsd: number): JudgmentStats {
	return {
		attempts: 1,
		tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
		costUsd,
		pagesRead: 2,
		pageCapHit: false,
	};
}

function verdictOutcome(runId: string, costUsd: number, rubricVersion = RUBRIC_V1): JudgeOutcome {
	return {
		kind: "verdict",
		verdict: validateVerdict({
			runId,
			assignments: [
				{
					class: "spin_loop",
					confidence: "high",
					evidence: [{ fromSeq: 1, toSeq: 2 }],
					note: "did the thing",
				},
			],
			provenance: {
				provider: "anthropic",
				model: MODEL,
				rubricVersion,
				judgedAt: NOW.toISOString(),
				costUsd,
				pagesRead: 2,
				pageCapHit: false,
			},
		}),
		stats: stats(costUsd),
	};
}

interface Harness {
	fake: FakeWarren;
	verdicts: VerdictStore;
	cursors: JudgmentCursorStore;
	spend: SpendLedger;
	judgeCalls: { runId: string; maxCostUsd: number }[];
	errors: { runId: string; err: unknown }[];
	skips: { runId: string; detail: string }[];
}

/**
 * Wire the collector against the fake warren with a stubbed judge. The
 * stub script maps runId to an outcome or a thrown error; unscripted runs
 * get a cheap verdict.
 */
function makeHarness(opts?: {
	script?: Record<string, JudgeOutcome | Error>;
	dailyBudgetUsd?: number;
	maxCostUsdPerJudgment?: number;
	now?: () => Date;
}): Harness & { deps: Parameters<typeof collectOnce>[0] } {
	const fake = new FakeWarren();
	fake.start();
	const verdicts = new VerdictStore(":memory:", { now: () => NOW });
	const cursors = new JudgmentCursorStore(":memory:");
	const spend = new SpendLedger(":memory:");
	const judgeCalls: { runId: string; maxCostUsd: number }[] = [];
	const errors: { runId: string; err: unknown }[] = [];
	const skips: { runId: string; detail: string }[] = [];
	const judge: JudgeFn = async (runId, { maxCostUsd }) => {
		judgeCalls.push({ runId, maxCostUsd });
		const scripted = opts?.script?.[runId];
		if (scripted instanceof Error) throw scripted;
		return scripted ?? verdictOutcome(runId, 0.01);
	};
	const deps: Parameters<typeof collectOnce>[0] = {
		client: createClient({ baseUrl: fake.baseUrl, token: "tok" }),
		verdicts,
		cursors,
		spend,
		judge,
		rubricVersion: RUBRIC_V1,
		judgeModelId: MODEL,
		maxCostUsdPerJudgment: opts?.maxCostUsdPerJudgment ?? 0.25,
		dailyBudgetUsd: opts?.dailyBudgetUsd ?? 5,
		now: opts?.now ?? (() => NOW),
		onRunError: (runId, err) => errors.push({ runId, err }),
		onBudgetDeferred: (runId, detail) => skips.push({ runId, detail }),
	};
	return { fake, verdicts, cursors, spend, judgeCalls, errors, skips, deps };
}

function teardown(h: Harness): void {
	h.fake.stop();
	h.verdicts.close();
	h.cursors.close();
	h.spend.close();
}

describe("collectOnce", () => {
	test("judges every terminal run and skips non-terminal ones", async () => {
		const h = makeHarness();
		h.fake.addRun({ id: "run-ok", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		h.fake.addRun({ id: "run-bad", state: "failed", startedAt: "2026-08-15T11:00:00.000Z" });
		h.fake.addRun({ id: "run-live", state: "running", startedAt: "2026-08-15T12:00:00.000Z" });
		try {
			const statsOut = await collectOnce(h.deps);
			expect(statsOut.runsDiscovered).toBe(3);
			expect(statsOut.terminalRuns).toBe(2);
			expect(statsOut.judged).toBe(2);
			expect(h.judgeCalls.map((c) => c.runId)).toEqual(["run-ok", "run-bad"]);
			expect(h.verdicts.count()).toBe(2);
			expect(h.cursors.needsJudgment("run-ok", RUBRIC_V1, MODEL)).toBe(false);
			expect(h.cursors.needsJudgment("run-live", RUBRIC_V1, MODEL)).toBe(true);
			expect(h.spend.spendForDay("2026-08-15")).toBeCloseTo(0.02, 10);
		} finally {
			teardown(h);
		}
	});

	test("replays nothing on a second cycle — cursor gate plus store dedupe", async () => {
		const h = makeHarness();
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		try {
			await collectOnce(h.deps);
			const second = await collectOnce(h.deps);
			expect(second.judged).toBe(0);
			expect(second.alreadyJudged).toBe(1);
			expect(h.judgeCalls).toHaveLength(1);
			expect(h.verdicts.count()).toBe(1);
		} finally {
			teardown(h);
		}
	});

	test("a judge throw leaves no cursor and no row, and the next cycle retries", async () => {
		const script: Record<string, JudgeOutcome | Error> = {
			"run-1": new Error("provider exploded"),
		};
		const h = makeHarness({ script });
		h.fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T10:00:00.000Z" });
		try {
			const first = await collectOnce(h.deps);
			expect(first.judged).toBe(0);
			expect(h.errors).toHaveLength(1);
			expect(h.verdicts.count()).toBe(0);
			expect(h.cursors.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(true);

			// Recover: unscript the failure and re-run — the run is judged.
			delete script["run-1"];
			const second = await collectOnce(h.deps);
			expect(second.judged).toBe(1);
			expect(h.verdicts.count()).toBe(1);
			expect(h.cursors.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(false);
		} finally {
			teardown(h);
		}
	});

	test("records an unjudged marker when the judge resolves unjudged", async () => {
		const h = makeHarness({
			script: {
				"run-1": {
					kind: "unjudged",
					reason: "malformed_verdict",
					detail: "exhausted attempts",
					stats: stats(0.03),
				},
			},
		});
		h.fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T10:00:00.000Z" });
		try {
			const out = await collectOnce(h.deps);
			expect(out.judged).toBe(1);
			const rows = h.verdicts.rowsForRun("run-1");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("unjudged");
			expect(rows[0]?.reason).toBe("malformed_verdict");
			expect(rows[0]?.detail).toBe("exhausted attempts");
			// Spend is ledgered even for an unjudged outcome — no refund.
			expect(h.spend.spendForDay("2026-08-15")).toBeCloseTo(0.03, 10);
			expect(h.cursors.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(false);
		} finally {
			teardown(h);
		}
	});

	test("a $0 failure is skipped, not marked, and the run comes back next cycle", async () => {
		const h = makeHarness({
			script: {
				"run-1": {
					kind: "unjudged",
					reason: "judge_error",
					detail: "401 invalid x-api-key",
					stats: stats(0),
				},
			},
		});
		h.fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T10:00:00.000Z" });
		const skips: string[] = [];
		try {
			const out = await collectOnce({ ...h.deps, onZeroCostSkipped: (id) => skips.push(id) });
			expect(out.zeroCostSkipped).toBe(1);
			expect(out.judged).toBe(0);
			expect(skips).toEqual(["run-1"]);
			// No marker: a row under the dedupe key would drop the run for good
			// over a failure nothing was paid for.
			expect(h.verdicts.rowsForRun("run-1")).toHaveLength(0);
			// No checkpoint either, so the next cycle re-lists it.
			expect(h.cursors.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(true);
		} finally {
			teardown(h);
		}
	});

	test("defers without a marker or checkpoint once the daily budget is exhausted", async () => {
		// Each stubbed judgment spends 0.01, so the first run lands exactly
		// on the budget and the rest see it exhausted.
		const h = makeHarness({ dailyBudgetUsd: 0.01 });
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		h.fake.addRun({ id: "run-2", state: "succeeded", startedAt: "2026-08-15T11:00:00.000Z" });
		h.fake.addRun({ id: "run-3", state: "succeeded", startedAt: "2026-08-15T12:00:00.000Z" });
		try {
			const out = await collectOnce(h.deps);
			expect(out.judged).toBe(1);
			expect(out.budgetDeferred).toBe(2);
			// Oldest first: run-1 was judged, the rest hit the exhausted budget.
			expect(h.judgeCalls.map((c) => c.runId)).toEqual(["run-1"]);
			// The deferral announces ONCE per cycle, not once per run.
			expect(h.skips).toHaveLength(1);
			expect(h.skips[0]?.runId).toBe("run-2");
			expect(h.skips[0]?.detail).toContain("daily budget");
			// No marker, no checkpoint: a budget_exceeded row would close the
			// run under this pair AND occupy the store's dedupe key, blocking
			// the eventual real verdict (warren-5fcf).
			expect(h.verdicts.rowsForRun("run-2")).toHaveLength(0);
			expect(h.cursors.needsJudgment("run-2", RUBRIC_V1, MODEL)).toBe(true);
			// Budget freed (next UTC day) — the oldest deferred run is
			// judged; the day's budget then gates the next one again.
			const nextDay = await collectOnce({
				...h.deps,
				now: () => new Date("2026-08-16T10:00:00.000Z"),
			});
			expect(nextDay.judged).toBe(1);
			expect(nextDay.budgetDeferred).toBe(1);
			expect(h.verdicts.rowsForRun("run-2")[0]?.kind).toBe("verdict");
		} finally {
			teardown(h);
		}
	});

	test("clamps the per-judgment cap to the remaining daily budget", async () => {
		const h = makeHarness({ dailyBudgetUsd: 0.05, maxCostUsdPerJudgment: 0.25 });
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		h.fake.addRun({ id: "run-2", state: "succeeded", startedAt: "2026-08-15T11:00:00.000Z" });
		try {
			await collectOnce(h.deps);
			// Each stubbed judgment spends 0.01, so run-2 sees 0.04 remaining.
			expect(h.judgeCalls[0]?.maxCostUsd).toBeCloseTo(0.05, 10);
			expect(h.judgeCalls[1]?.maxCostUsd).toBeCloseTo(0.04, 10);
		} finally {
			teardown(h);
		}
	});

	test("a prior day's spend does not count against today's budget", async () => {
		const h = makeHarness({ dailyBudgetUsd: 0.015 });
		h.spend.record(100, new Date("2026-08-14T23:00:00.000Z"));
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		try {
			const out = await collectOnce(h.deps);
			expect(out.judged).toBe(1);
			expect(out.budgetDeferred).toBe(0);
		} finally {
			teardown(h);
		}
	});

	test("a new rubric version re-judges and appends, never overwrites", async () => {
		const h = makeHarness();
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		try {
			await collectOnce(h.deps);
			const out = await collectOnce({
				...h.deps,
				rubricVersion: RUBRIC_V2,
				judge: async (runId) => verdictOutcome(runId, 0.01, RUBRIC_V2),
			});
			expect(out.judged).toBe(1);
			expect(h.verdicts.count()).toBe(2);
			expect(h.verdicts.rowsForRubricVersion(RUBRIC_V1)).toHaveLength(1);
			expect(h.verdicts.rowsForRubricVersion(RUBRIC_V2)).toHaveLength(1);
		} finally {
			teardown(h);
		}
	});
});

describe("runJudgeCollector", () => {
	test("cycles until aborted and finishes the in-flight judgment", async () => {
		const h = makeHarness();
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		const ctrl = new AbortController();
		const cycles: number[] = [];
		try {
			await runJudgeCollector({
				...h.deps,
				pollIntervalMs: 1,
				signal: ctrl.signal,
				// Abort inside the in-flight judgment: the loop must still let
				// the cycle complete, checkpoint, and only then exit.
				judge: async (runId, opts) => {
					ctrl.abort();
					return h.deps.judge(runId, opts);
				},
				sleep: async () => {},
				onCycle: (s) => cycles.push(s.judged),
			});
			expect(cycles).toEqual([1]);
			expect(h.verdicts.count()).toBe(1);
			expect(h.cursors.needsJudgment("run-1", RUBRIC_V1, MODEL)).toBe(false);
		} finally {
			teardown(h);
		}
	});

	test("keeps cycling across runs and reports cycle stats", async () => {
		const h = makeHarness();
		h.fake.addRun({ id: "run-1", state: "succeeded", startedAt: "2026-08-15T10:00:00.000Z" });
		const ctrl = new AbortController();
		const seen: number[] = [];
		try {
			await runJudgeCollector({
				...h.deps,
				pollIntervalMs: 1,
				signal: ctrl.signal,
				sleep: async () => {
					// After the first cycle, add a second terminal run; abort
					// after the second cycle.
					if (seen.length === 1) {
						h.fake.addRun({
							id: "run-2",
							state: "failed",
							startedAt: "2026-08-15T11:00:00.000Z",
						});
					}
					if (seen.length >= 2) ctrl.abort();
				},
				onCycle: (s) => seen.push(s.judged),
			});
			expect(seen).toEqual([1, 1]);
			expect(h.verdicts.count()).toBe(2);
		} finally {
			teardown(h);
		}
	});
});
