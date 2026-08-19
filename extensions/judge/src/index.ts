/**
 * @warren-ext/judge entrypoint: the collector daemon.
 *
 * Resolves the environment contract, opens the extension-owned stores
 * (verdicts, judgment cursors, spend ledger — all in the one SQLite file),
 * builds the pi-SDK judge session factory, and runs the collector loop:
 * poll `GET /runs` for newly-terminal runs, judge each under rubric v1,
 * checkpoint only after the verdict store accepts. SIGTERM/SIGINT aborts
 * the loop between cycles, so the in-flight judgment always finishes and
 * checkpoints before exit.
 *
 * Boundary contract (enforced by scripts/check-layers.ts): this package
 * imports nothing from warren's `src/` or `scripts/`. Everything it knows
 * about warren's wire shapes is hand-derived in `warren-wire.ts`.
 */
import { CalibrationMetricStore, runCalibrationLoop } from "./calibration.ts";
import { createClient } from "./client.ts";
import { type JudgeFn, runJudgeCollector } from "./collector.ts";
import { ConfigError, resolveConfig } from "./config.ts";
import { JudgmentCursorStore } from "./cursor-store.ts";
import { createExportServer } from "./server.ts";
import { judgeRun } from "./judge-loop.ts";
import { createPiSessionFactory } from "./pi-session.ts";
import { computeRubricVersion } from "./rubric.ts";
import { SpendLedger } from "./spend-ledger.ts";
import { VerdictStore } from "./verdict-store.ts";

export const EXTENSION_NAME = "judge";
export const EXTENSION_VERSION = "0.0.0";

export {
	type AgreementReport,
	CalibrationMetricStore,
	calibrateOnce,
	computeAgreement,
	runCalibrationLoop,
	strongJudgeModelId,
} from "./calibration.ts";
export { createClient, WarrenHttpError } from "./client.ts";
export { collectOnce, runJudgeCollector, type JudgeCycleStats, type JudgeFn } from "./collector.ts";
export { type JudgeConfig, resolveConfig } from "./config.ts";
export { JudgmentCursorStore, type JudgmentCursor } from "./cursor-store.ts";
export { type JudgeOutcome, judgeRun } from "./judge-loop.ts";
export { computeRubricVersion, renderJudgeSystemPrompt } from "./rubric.ts";
export { createExportServer, createFetchHandler } from "./server.ts";
export { dayKey, SpendLedger } from "./spend-ledger.ts";
export { VerdictStore } from "./verdict-store.ts";

async function main(): Promise<void> {
	let config;
	try {
		config = resolveConfig(process.env);
	} catch (error) {
		const message = error instanceof ConfigError ? error.message : String(error);
		console.error(`${EXTENSION_NAME}: ${message}`);
		process.exit(1);
	}

	const client = createClient({
		baseUrl: config.warrenBaseUrl,
		token: config.warrenApiToken,
	});
	const verdicts = new VerdictStore(config.dbPath);
	const cursors = new JudgmentCursorStore(config.dbPath);
	const spend = new SpendLedger(config.dbPath);
	const rubricVersion = computeRubricVersion();
	const sessionFactory = createPiSessionFactory({
		provider: config.provider,
		model: config.model,
	});

	const judge: JudgeFn = (runId, { maxCostUsd }) =>
		judgeRun({
			client,
			runId,
			provider: config.provider,
			model: config.model,
			rubricVersion,
			sessionFactory,
			maxRetries: config.maxRetries,
			maxPages: config.maxPages,
			eventsPageSize: config.eventsPageSize,
			maxCostUsdPerJudgment: maxCostUsd,
		});

	const ctrl = new AbortController();
	let exportServer: ReturnType<typeof createExportServer> | null = null;
	const shutdown = (): void => {
		ctrl.abort();
		exportServer?.stop(true);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	const calibration = config.calibration;
	const metrics = calibration === null ? null : new CalibrationMetricStore(config.dbPath);
	const calibrationLoop =
		calibration === null || metrics === null
			? null
			: runCalibrationLoop({
					verdicts,
					metrics,
					spend,
					judge: (runId, { maxCostUsd }) =>
						judgeRun({
							client,
							runId,
							provider: calibration.provider,
							model: calibration.model,
							rubricVersion,
							sessionFactory: createPiSessionFactory({
								provider: calibration.provider,
								model: calibration.model,
							}),
							maxRetries: config.maxRetries,
							maxPages: config.maxPages,
							eventsPageSize: config.eventsPageSize,
							maxCostUsdPerJudgment: maxCostUsd,
						}),
					rubricVersion,
					cheapModelId: config.model,
					strongProvider: calibration.provider,
					strongModelId: calibration.model,
					sampleSize: calibration.sampleSize,
					maxCostUsdPerJudgment: config.maxCostUsdPerJudgment,
					dailyBudgetUsd: config.dailyBudgetUsd,
					intervalMs: calibration.intervalMs,
					signal: ctrl.signal,
					onCycle: (stats) =>
						console.error(
							`${EXTENSION_NAME}: calibration — ${stats.sampled} sampled, ` +
								`${stats.rejudged} re-judged, ${stats.budgetDeferred} budget-deferred, ` +
								`agreement ${String(stats.report.overallRate)} over ` +
								`${stats.report.sampledPairs} pairs`,
						),
					onCycleError: (err) =>
						console.error(`${EXTENSION_NAME}: calibration pass failed:`, err),
					onRunError: (runId, err) =>
						console.error(`${EXTENSION_NAME}: calibration re-judge for run ${runId} failed:`, err),
					onBudgetDeferred: (runId, detail) =>
						console.error(`${EXTENSION_NAME}: calibration deferring from run ${runId}: ${detail}`),
				});
	exportServer =
		config.exportToken === null
			? null
			: createExportServer({
					verdicts,
					metrics,
					exportToken: config.exportToken,
					extensionName: EXTENSION_NAME,
					extensionVersion: EXTENSION_VERSION,
					port: config.exportPort,
				});
	if (exportServer === null) {
		console.error(
			`${EXTENSION_NAME}: JUDGE_EXPORT_TOKEN unset — export surface disabled ` +
				`(no public projection exists; set the token to serve /verdicts.jsonl)`,
		);
	} else {
		console.error(`${EXTENSION_NAME}: export surface on :${config.exportPort} (bearer-gated)`);
	}
	if (calibration !== null) {
		console.error(
			`${EXTENSION_NAME}: calibration ${calibration.provider}/${calibration.model} ` +
				`every ${calibration.intervalMs}ms, sample ${calibration.sampleSize}`,
		);
	}

	console.error(
		`${EXTENSION_NAME} ${EXTENSION_VERSION}: judging ${config.warrenBaseUrl} ` +
			`every ${config.pollIntervalMs}ms (db ${config.dbPath}, ` +
			`judge=${config.provider}/${config.model}, rubric=${rubricVersion}, ` +
			`caps $${config.maxCostUsdPerJudgment}/judgment, ` +
			`$${config.dailyBudgetUsd}/day)`,
	);
	await Promise.all([
		...(calibrationLoop === null ? [] : [calibrationLoop]),
		runJudgeCollector({
		client,
		verdicts,
		cursors,
		spend,
		judge,
		rubricVersion,
		judgeModelId: config.model,
		maxCostUsdPerJudgment: config.maxCostUsdPerJudgment,
		dailyBudgetUsd: config.dailyBudgetUsd,
		pollIntervalMs: config.pollIntervalMs,
		signal: ctrl.signal,
		onCycle: (stats) =>
			console.error(
				`${EXTENSION_NAME}: cycle — ${stats.terminalRuns} terminal, ` +
					`${stats.judged} judged, ${stats.alreadyJudged} current, ` +
					`${stats.budgetDeferred} budget-deferred`,
			),
		onCycleError: (err) => console.error(`${EXTENSION_NAME}: cycle failed:`, err),
		onRunError: (runId, err) =>
			console.error(`${EXTENSION_NAME}: judgment for run ${runId} failed:`, err),
		// The store persists a fresh marker's detail (warren-a106), but a
		// dedupe conflict drops the insert, so this log line stays the only
		// sink for a replayed marker's detail (warren-5fcf: 334 judge_error
		// markers with no error text anywhere).
		onJudgment: (runId, outcome) => {
			if (outcome.kind === "unjudged") {
				console.error(
					`${EXTENSION_NAME}: run ${runId} unjudged (${outcome.reason}): ${outcome.detail}`,
				);
			}
		},
		onBudgetDeferred: (runId, detail) =>
			console.error(`${EXTENSION_NAME}: deferring from run ${runId}: ${detail}`),
		}),
	]);
	verdicts.close();
	cursors.close();
	spend.close();
	metrics?.close();
	console.error(`${EXTENSION_NAME}: stopped; ${verdicts.count()} verdict rows stored`);
}

if (import.meta.main) await main();
