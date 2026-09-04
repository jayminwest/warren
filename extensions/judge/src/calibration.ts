/**
 * The calibration re-judge (plan pl-17ca step 7, agent-analytics §12.5).
 *
 * Full coverage by a cheap model inverts the sampling question: a periodic
 * strong-model pass re-judges a small RANDOM sample of already-judged runs
 * under the SAME rubric version, and the cheap↔strong disagreement rate is
 * itself the tracked metric that drives any future taxonomy narrowing.
 *
 * Append discipline: the strong pass records verdicts with the strong
 * model's `provider/model` as the judge model id, so the verdict store's
 * dedupe key `(runId, rubricVersion, judgeModelId)` makes every calibration
 * verdict an APPEND — the cheap verdict is never overwritten, and a replay
 * of the same sample is an exact no-op.
 *
 * Budget gates apply to calibration judgments exactly as to first-pass
 * ones: the fleet daily budget and the per-judgment cap are shared. Past
 * the daily budget the sampled run is DEFERRED — no marker, no store
 * write — mirroring the collector's semantics (PR #969): a
 * `budget_exceeded` marker under the strong model id would occupy the
 * dedupe key and permanently exclude the run from every future sample.
 * The deferral stays visible in the cycle stats and the once-per-pass
 * deferral log line. Per-judgment failures (judge_error,
 * malformed_verdict, a mid-attempt cap breach) still record markers,
 * because the attempts were billed. A failure that cost $0 was not
 * billed, so it is skipped the same way a deferral is (warren-d8df): an
 * expired key or a missing model would otherwise take the dedupe key and
 * drop the run from every future sample without a model ever reading it.
 *
 * The agreement rate is computed from the store's calibration join and
 * persisted per rubric version in the `calibration_metrics` table, so the
 * metric is queryable without recomputing the join.
 */

import { Database } from "bun:sqlite";
import type { JudgeFn } from "./collector.ts";
import { dayKey, type SpendLedger } from "./spend-ledger.ts";
import type { CalibrationPair, VerdictStore } from "./verdict-store.ts";
import { VERDICT_CLASSES, type VerdictClass } from "./wire.ts";

/** Default random sample size per calibration pass (JUDGE_CALIBRATION_SAMPLE_SIZE). */
export const DEFAULT_CALIBRATION_SAMPLE_SIZE = 20;
/** Default cadence between calibration passes (JUDGE_CALIBRATION_INTERVAL_MS). */
export const DEFAULT_CALIBRATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Band-agreement tally for one taxonomy class over the sampled pairs. */
export interface ClassAgreement {
	/** Pairs where at least one leg assigned this class. */
	readonly compared: number;
	/** Pairs where BOTH legs assigned this class with the same band. */
	readonly agreed: number;
	/** agreed / compared, or null when neither leg ever assigned the class. */
	readonly rate: number | null;
}

/**
 * The persisted calibration metric (§12.5): per-class and overall
 * band-agreement between the cheap and strong judge over the paired sample,
 * for one rubric version. Trend lines must never mix rubric versions, so
 * the rubric version is part of the metric's identity.
 */
export interface AgreementReport {
	readonly rubricVersion: string;
	readonly cheapModelId: string;
	readonly strongModelId: string;
	/** Pairs the rate was computed over (runs judged by BOTH models). */
	readonly sampledPairs: number;
	readonly perClass: Record<VerdictClass, ClassAgreement>;
	/** Pairs whose full class→band maps match exactly. */
	readonly overallAgreed: number;
	/** overallAgreed / sampledPairs, or null when no pairs exist yet. */
	readonly overallRate: number | null;
	readonly computedAt: string;
}

function bandMap(pair: CalibrationPair, leg: "cheap" | "strong"): Map<VerdictClass, string> {
	const map = new Map<VerdictClass, string>();
	for (const assignment of pair[leg].assignments) {
		map.set(assignment.class, assignment.confidence);
	}
	return map;
}

/**
 * Exact-match band agreement over the calibration join. Per class, a pair
 * agrees when both legs assign the class with the same confidence band; a
 * pair where neither leg assigns the class is not evidence about that
 * class and stays out of its denominator. Overall, a pair agrees when the
 * two legs' full class→band maps are identical.
 */
export function computeAgreement(
	pairs: readonly CalibrationPair[],
	identity: { rubricVersion: string; cheapModelId: string; strongModelId: string },
	now: () => Date = () => new Date(),
): AgreementReport {
	const perClass = {} as Record<VerdictClass, ClassAgreement>;
	let overallAgreed = 0;
	for (const verdictClass of VERDICT_CLASSES) {
		let compared = 0;
		let agreed = 0;
		for (const pair of pairs) {
			const cheapBand = bandMap(pair, "cheap").get(verdictClass);
			const strongBand = bandMap(pair, "strong").get(verdictClass);
			if (cheapBand === undefined && strongBand === undefined) continue;
			compared += 1;
			if (cheapBand !== undefined && cheapBand === strongBand) agreed += 1;
		}
		perClass[verdictClass] = {
			compared,
			agreed,
			rate: compared === 0 ? null : agreed / compared,
		};
	}
	for (const pair of pairs) {
		const cheap = bandMap(pair, "cheap");
		const strong = bandMap(pair, "strong");
		if (cheap.size !== strong.size) continue;
		let equal = true;
		for (const [verdictClass, band] of cheap) {
			if (strong.get(verdictClass) !== band) {
				equal = false;
				break;
			}
		}
		if (equal) overallAgreed += 1;
	}
	return {
		...identity,
		sampledPairs: pairs.length,
		perClass,
		overallAgreed,
		overallRate: pairs.length === 0 ? null : overallAgreed / pairs.length,
		computedAt: now().toISOString(),
	};
}

const METRICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS calibration_metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	rubric_version TEXT NOT NULL,
	cheap_model_id TEXT NOT NULL,
	strong_model_id TEXT NOT NULL,
	sampled_pairs INTEGER NOT NULL,
	per_class TEXT NOT NULL,
	overall_agreed INTEGER NOT NULL,
	overall_rate REAL,
	computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calibration_metrics_rubric_idx
	ON calibration_metrics (rubric_version, id);
`;

interface RawMetricRow {
	rubric_version: string;
	cheap_model_id: string;
	strong_model_id: string;
	sampled_pairs: number;
	per_class: string;
	overall_agreed: number;
	overall_rate: number | null;
	computed_at: string;
}

function toReport(row: RawMetricRow): AgreementReport {
	return {
		rubricVersion: row.rubric_version,
		cheapModelId: row.cheap_model_id,
		strongModelId: row.strong_model_id,
		sampledPairs: row.sampled_pairs,
		perClass: JSON.parse(row.per_class) as Record<VerdictClass, ClassAgreement>,
		overallAgreed: row.overall_agreed,
		overallRate: row.overall_rate,
		computedAt: row.computed_at,
	};
}

/**
 * The queryable calibration-metric surface: one append-only row per
 * completed calibration pass, keyed by rubric version. Lives in the same
 * extension-owned SQLite file as the verdict store.
 */
export class CalibrationMetricStore {
	readonly #db: Database;

	constructor(path: string) {
		this.#db = new Database(path);
		this.#db.run("PRAGMA journal_mode = WAL;");
		this.#db.run(METRICS_SCHEMA);
	}

	/** Persist one pass's report. Returns the new row id. */
	record(report: AgreementReport): number {
		const result = this.#db.run(
			`INSERT INTO calibration_metrics
				(rubric_version, cheap_model_id, strong_model_id, sampled_pairs,
				 per_class, overall_agreed, overall_rate, computed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				report.rubricVersion,
				report.cheapModelId,
				report.strongModelId,
				report.sampledPairs,
				JSON.stringify(report.perClass),
				report.overallAgreed,
				report.overallRate,
				report.computedAt,
			],
		);
		return Number(result.lastInsertRowid);
	}

	/** The most recent report for one rubric version, or null. */
	latestForRubric(rubricVersion: string): AgreementReport | null {
		const row = this.#db
			.query(
				`SELECT * FROM calibration_metrics
				 WHERE rubric_version = ? ORDER BY id DESC LIMIT 1`,
			)
			.get(rubricVersion) as unknown as RawMetricRow | null;
		return row === null ? null : toReport(row);
	}

	/** Every rubric version with at least one stored report, sorted. */
	rubricVersions(): string[] {
		const rows = this.#db
		.query("SELECT DISTINCT rubric_version AS v FROM calibration_metrics ORDER BY v")
		.all() as unknown as Array<{ v: string }>;
		return rows.map((row) => row.v);
	}

	/** Report history for one rubric version, newest first. */
	historyForRubric(rubricVersion: string, limit: number): AgreementReport[] {
		const rows = this.#db
			.query(
				`SELECT * FROM calibration_metrics
				 WHERE rubric_version = ? ORDER BY id DESC LIMIT ?`,
			)
			.all(rubricVersion, limit) as unknown as RawMetricRow[];
		return rows.map(toReport);
	}

	close(): void {
		this.#db.close();
	}
}

export interface CalibrationDeps {
	readonly verdicts: VerdictStore;
	readonly metrics: CalibrationMetricStore;
	readonly spend: SpendLedger;
	/** The strong-model judge seam — same shape as the collector's. */
	readonly judge: JudgeFn;
	readonly rubricVersion: string;
	/** The first-pass judge's model id, as recorded in its verdicts. */
	readonly cheapModelId: string;
	readonly strongProvider: string;
	readonly strongModelId: string;
	/** Random sample size per pass (JUDGE_CALIBRATION_SAMPLE_SIZE). */
	readonly sampleSize: number;
	/** Per-judgment USD cap, shared with the first-pass budget. */
	readonly maxCostUsdPerJudgment: number;
	/** Fleet-wide daily USD budget, shared with the first-pass budget. */
	readonly dailyBudgetUsd: number;
	readonly now?: () => Date;
	/** Injectable entropy source for the random sample (tests). */
	readonly random?: () => number;
	readonly onRunError?: (runId: string, err: unknown) => void;
	readonly onJudgment?: (runId: string, outcome: string) => void;
	/** Once per pass, on the first budget deferral — loud by design (§12.5). */
	readonly onBudgetDeferred?: (runId: string, detail: string) => void;
	/** Once per pass, when a $0 failure is skipped instead of marked. */
	readonly onZeroCostSkipped?: (runId: string, detail: string) => void;
}

export interface CalibrationCycleStats {
	readonly candidates: number;
	readonly sampled: number;
	readonly rejudged: number;
	/** Sampled runs deferred by the exhausted daily budget — no row written. */
	readonly budgetDeferred: number;
	/** Runs skipped (not marked) because the attempt cost nothing. */
	readonly zeroCostSkipped: number;
	readonly report: AgreementReport;
}

/** The strong pass's judge model id: provider-qualified, cross-provider safe. */
export function strongJudgeModelId(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/**
 * Runs eligible for the calibration sample: judged by the cheap model under
 * this rubric version, with no row yet from the strong model (a verdict OR
 * an unjudged marker from a billed attempt). A budget deferral writes no
 * row, so a deferred run re-enters the candidate pool next pass.
 */
function calibrationCandidates(deps: CalibrationDeps, strongId: string): string[] {
	const cheapJudged = new Set<string>();
	const strongResolved = new Set<string>();
	for (const row of deps.verdicts.rowsForRubricVersion(deps.rubricVersion)) {
		if (row.judgeModelId === strongId) strongResolved.add(row.runId);
		if (row.kind === "verdict" && row.judgeModelId === deps.cheapModelId) {
			cheapJudged.add(row.runId);
		}
	}
	return [...cheapJudged].filter((runId) => !strongResolved.has(runId)).sort();
}

/** Uniform random sample of `size` run ids via a partial Fisher–Yates shuffle. */
function sampleRuns(candidates: string[], size: number, random: () => number): string[] {
	const pool = [...candidates];
	const picked: string[] = [];
	const n = Math.min(size, pool.length);
	for (let i = 0; i < n; i += 1) {
		const j = i + Math.floor(random() * (pool.length - i));
		const chosen = pool[j] as string;
		pool[j] = pool[i] as string;
		pool[i] = chosen;
		// The element swapped INTO slot i is the pick. Pushing the element
		// that used to sit at i selected candidates[0..n) in sorted order on
		// every pass, so the live "random sample" walked the run ids
		// alphabetically (551 qwen markers in id order, 2026-08-21..09-01).
		picked.push(chosen);
	}
	return picked;
}

/**
 * One calibration pass: sample, budget-gate, re-judge, append, then compute
 * and persist the agreement report. The report is computed over the FULL
 * join (every run both models have judged), not just this pass's sample, so
 * the metric accumulates across passes.
 */
export async function calibrateOnce(deps: CalibrationDeps): Promise<CalibrationCycleStats> {
	const now = deps.now ?? (() => new Date());
	const random = deps.random ?? Math.random;
	const strongId = strongJudgeModelId(deps.strongProvider, deps.strongModelId);
	const candidates = calibrationCandidates(deps, strongId);
	const sample = sampleRuns(candidates, deps.sampleSize, random);

	let rejudged = 0;
	let budgetDeferred = 0;
	let zeroCostSkipped = 0;
	let zeroCostAnnounced = false;
	let deferralAnnounced = false;
	for (const runId of sample) {
		try {
			const today = dayKey(now());
			const spentToday = deps.spend.spendForDay(today);
			const remaining = deps.dailyBudgetUsd - spentToday;
			if (remaining <= 0) {
				// DEFER, never mark (PR #969 semantics): a budget_exceeded
				// marker under the strong id would occupy the dedupe key and
				// permanently exclude this run from every future sample. No
				// write means the next pass can re-draw it.
				budgetDeferred += 1;
				if (!deferralAnnounced) {
					deferralAnnounced = true;
					deps.onBudgetDeferred?.(
						runId,
						`fleet daily budget $${deps.dailyBudgetUsd.toFixed(4)} exhausted ` +
							`($${spentToday.toFixed(4)} spent on ${today})`,
					);
				}
				continue;
			}
			const maxCostUsd = Math.min(deps.maxCostUsdPerJudgment, remaining);
			const outcome = await deps.judge(runId, { maxCostUsd });
			if (outcome.kind === "verdict") {
				// Stamp the strong model's provider-qualified id onto the
				// provenance: the dedupe key derives from it, and the
				// calibration join matches on it. The judge loop itself only
				// knows the bare model id it resolved.
				deps.verdicts.recordVerdict({
					...outcome.verdict,
					provenance: {
						...outcome.verdict.provenance,
						provider: deps.strongProvider,
						model: strongId,
					},
				});
			} else if (outcome.stats.costUsd === 0) {
				// SKIP, never mark: the marker rationale above is that the
				// attempts were billed, and a $0 attempt was not. Writing one
				// would occupy the dedupe key over a failure no model was paid
				// for, so the run leaves the pool for good. No write means the
				// next pass re-draws it.
				zeroCostSkipped += 1;
				if (!zeroCostAnnounced) {
					zeroCostAnnounced = true;
					deps.onZeroCostSkipped?.(
						runId,
						`${outcome.reason} at $0.0000, not marked: ${outcome.detail}`,
					);
				}
				continue;
			} else {
				deps.verdicts.recordUnjudged({
					runId,
					rubricVersion: deps.rubricVersion,
					judgeModelId: strongId,
					reason: outcome.reason,
					detail: outcome.detail,
				});
			}
			// Spend is ledgered for every outcome — an unjudged marker is not a
			// refund, the provider billed the attempts either way.
			deps.spend.record(outcome.stats.costUsd, now());
			deps.onJudgment?.(runId, outcome.kind);
			rejudged += 1;
		} catch (err) {
			// Per-run isolation: one failing re-judgment must not starve the
			// rest of the sample. No row was written, so the next pass can
			// re-draw this run.
			deps.onRunError?.(runId, err);
		}
	}

	const pairs = deps.verdicts.calibrationPairs(deps.rubricVersion, deps.cheapModelId, strongId);
	const report = computeAgreement(
		pairs,
		{ rubricVersion: deps.rubricVersion, cheapModelId: deps.cheapModelId, strongModelId: strongId },
		now,
	);
	deps.metrics.record(report);
	return {
		candidates: candidates.length,
		sampled: sample.length,
		rejudged,
		budgetDeferred,
		zeroCostSkipped,
		report,
	};
}

export interface RunCalibrationLoopOptions extends CalibrationDeps {
	readonly intervalMs: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly onCycleError?: (err: unknown) => void;
	readonly onCycle?: (stats: CalibrationCycleStats) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The calibration loop: pass, sleep, repeat until the signal aborts. Same
 * graceful-shutdown discipline as the collector — the abort is observed
 * only BETWEEN passes, so an in-flight re-judgment always finishes.
 */
export async function runCalibrationLoop(opts: RunCalibrationLoopOptions): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep;
	while (opts.signal?.aborted !== true) {
		try {
			const stats = await calibrateOnce(opts);
			opts.onCycle?.(stats);
		} catch (err) {
			opts.onCycleError?.(err);
		}
		await sleep(opts.intervalMs);
	}
}
