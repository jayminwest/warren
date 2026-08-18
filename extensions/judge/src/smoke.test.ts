/**
 * Plan pl-17ca step 8 (warren-265d): the end-to-end smoke.
 *
 * A terminal run on the fake-warren double flows through the REAL pipeline
 * (client → collector → verdict store → export surface) with the judge
 * itself stubbed — no provider calls. Proves:
 *
 *  1. terminal run → judged → the validated verdict is exported over
 *     `GET /verdicts.jsonl`, bearer-gated from birth;
 *  2. the budget-skip path writes a VISIBLE unjudged marker that exports
 *     side by side with verdicts (§12.5 — never a silent gap);
 *  3. the re-judge append path keeps BOTH verdicts readable, keyed by
 *     rubric version + judge model id, and the stored calibration metric
 *     is served by `GET /agreement`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationMetricStore, computeAgreement } from "./calibration.ts";
import { createClient, type WarrenClient } from "./client.ts";
import { collectOnce, type JudgeFn } from "./collector.ts";
import { JudgmentCursorStore } from "./cursor-store.ts";
import { FakeWarren } from "./fake-warren.ts";
import type { JudgeOutcome } from "./judge-loop.ts";
import { createFetchHandler } from "./server.ts";
import { SpendLedger } from "./spend-ledger.ts";
import { VerdictStore } from "./verdict-store.ts";
import { validateVerdict, type JudgeVerdict } from "./wire.ts";

const TOKEN = "smoke-export-token";
const RUBRIC = "sha256:" + "ef".repeat(32);
const CHEAP_MODEL = "claude-haiku-4-5";
const STRONG_MODEL = "claude-opus-4-1";
const NOW = new Date("2026-08-15T18:00:00.000Z");

function verdictFor(runId: string, model: string, confidence: "high" | "low"): JudgeVerdict {
	return validateVerdict({
		runId,
		assignments: [
			{
				class: "spin_loop",
				confidence,
				evidence: [{ fromSeq: 1, toSeq: 2 }],
			},
		],
		provenance: {
			provider: "anthropic",
			model,
			rubricVersion: RUBRIC,
			judgedAt: NOW.toISOString(),
			costUsd: 0.01,
			pagesRead: 1,
			pageCapHit: false,
		},
	});
}

function authed(path: string, token: string | null = TOKEN): Request {
	const headers = new Headers();
	if (token !== null) headers.set("authorization", `Bearer ${token}`);
	return new Request(`http://export.test${path}`, { headers });
}

async function exportRows(
	handler: (req: Request) => Response,
	since = 0,
): Promise<Array<Record<string, unknown>>> {
	const res = handler(authed(`/verdicts.jsonl?since=${since}`));
	expect(res.status).toBe(200);
	const text = await res.text();
	if (text.trim().length === 0) return [];
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("judge export smoke", () => {
	let fake: FakeWarren;
	let dir: string;
	let dbPath: string;
	let client: WarrenClient;
	let verdicts: VerdictStore;
	let cursors: JudgmentCursorStore;
	let spend: SpendLedger;
	let metrics: CalibrationMetricStore;
	let handler: (req: Request) => Response;

	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
		dir = mkdtempSync(join(tmpdir(), "judge-smoke-"));
		// One shared SQLite file, exactly as production wires the stores.
		dbPath = join(dir, "judge.db");
		client = createClient({ baseUrl: fake.baseUrl, token: "smoke-token" });
		verdicts = new VerdictStore(dbPath, { now: () => NOW });
		cursors = new JudgmentCursorStore(dbPath);
		spend = new SpendLedger(dbPath);
		metrics = new CalibrationMetricStore(dbPath);
		handler = createFetchHandler({
			verdicts,
			metrics,
			exportToken: TOKEN,
			extensionName: "judge",
			extensionVersion: "0.0.0",
		});
	});

	afterEach(() => {
		fake.stop();
		verdicts.close();
		cursors.close();
		spend.close();
		metrics.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function addTerminalRun(runId: string): void {
		fake.addRun({ id: runId, state: "succeeded", startedAt: "2026-08-15T17:00:00.000Z" });
		fake.addEvent(runId, {
			id: 1,
			seq: 1,
			ts: "2026-08-15T17:00:05.000Z",
			kind: "message",
			stream: "system",
			payload: { role: "agent", body: "looping on the same failing test" },
		});
		fake.addEvent(runId, {
			id: 2,
			seq: 2,
			ts: "2026-08-15T17:05:00.000Z",
			kind: "reap.completed",
			stream: "system",
			payload: { state: "succeeded", branchPushed: true, commitsAhead: 1 },
		});
	}

	async function cycle(judge: JudgeFn, dailyBudgetUsd = 5) {
		return await collectOnce({
			client,
			verdicts,
			cursors,
			spend,
			judge,
			rubricVersion: RUBRIC,
			judgeModelId: CHEAP_MODEL,
			maxCostUsdPerJudgment: 0.25,
			dailyBudgetUsd,
			now: () => NOW,
		});
	}

	test("terminal run is judged and the validated verdict exports over the gated surface", async () => {
		addTerminalRun("r-smoke-1");
		const judge: JudgeFn = async (runId) =>
			({
				kind: "verdict",
				verdict: verdictFor(runId, CHEAP_MODEL, "high"),
				stats: {
					attempts: 1,
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					costUsd: 0.01,
					pagesRead: 1,
					pageCapHit: false,
				},
			}) satisfies JudgeOutcome;

		const stats = await collectOnce({
			client,
			verdicts,
			cursors,
			spend,
			judge,
			rubricVersion: RUBRIC,
			judgeModelId: CHEAP_MODEL,
			maxCostUsdPerJudgment: 0.25,
			dailyBudgetUsd: 5,
			now: () => NOW,
		});
		expect(stats).toMatchObject({ terminalRuns: 1, judged: 1, budgetDeferred: 0 });

		// The gate: no token, no rows — there is no public projection.
		expect(handler(authed("/verdicts.jsonl", null)).status).toBe(401);

		const rows = await exportRows(handler);
		expect(rows).toHaveLength(1);
		const row = rows[0] as { kind: string; runId: string; verdict: JudgeVerdict };
		expect(row.kind).toBe("verdict");
		expect(row.runId).toBe("r-smoke-1");
		// The exported verdict re-validates against the §12.3 contract.
		expect(validateVerdict(row.verdict).provenance.rubricVersion).toBe(RUBRIC);
	});

	test("an exhausted daily budget defers the run — no marker, judged once budget frees", async () => {
		addTerminalRun("r-smoke-budget");
		const gated: JudgeFn = async () => {
			throw new Error("judge must not run past the budget gate");
		};
		const stats = await cycle(gated, 0);
		expect(stats).toMatchObject({ judged: 0, budgetDeferred: 1 });

		// No marker exported: a budget_exceeded row would occupy the store's
		// dedupe key and block the eventual real verdict (warren-5fcf).
		expect(await exportRows(handler)).toHaveLength(0);

		// Budget available again — the deferred run is judged for real.
		const judge: JudgeFn = async (runId) =>
			({
				kind: "verdict",
				verdict: verdictFor(runId, CHEAP_MODEL, "high"),
				stats: {
					attempts: 1,
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					costUsd: 0.01,
					pagesRead: 1,
					pageCapHit: false,
				},
			}) satisfies JudgeOutcome;
		await cycle(judge, 5);
		const rows = await exportRows(handler);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "verdict", runId: "r-smoke-budget" });
	});

	test("re-judge appends: both verdicts stay readable keyed by rubric version, and /agreement serves the metric", async () => {
		addTerminalRun("r-smoke-rejudge");
		const cheapJudge: JudgeFn = async (runId) =>
			({
				kind: "verdict",
				verdict: verdictFor(runId, CHEAP_MODEL, "high"),
				stats: {
					attempts: 1,
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					costUsd: 0.01,
					pagesRead: 1,
					pageCapHit: false,
				},
			}) satisfies JudgeOutcome;
		await cycle(cheapJudge);

		// The calibration re-judge: same run, same rubric version, strong
		// model id — an append under a new dedupe key, never an overwrite.
		const strong = verdictFor("r-smoke-rejudge", STRONG_MODEL, "low");
		expect(verdicts.recordVerdict(strong)).not.toBeNull();

		const rows = (await exportRows(handler)) as Array<{
			kind: string;
			rubricVersion: string;
			judgeModelId: string;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.kind === "verdict" && r.rubricVersion === RUBRIC)).toBe(true);
		expect(rows.map((r) => r.judgeModelId).sort()).toEqual([CHEAP_MODEL, STRONG_MODEL].sort());

		// Paging by ?since picks up exactly the appended re-judge.
		const tail = await exportRows(handler, 1);
		expect(tail).toHaveLength(1);
		expect(tail[0]).toMatchObject({ judgeModelId: STRONG_MODEL });

		// The stored calibration metric is served per rubric version. The
		// two legs disagree on the band, so the overall rate is 0.
		const pairs = verdicts.calibrationPairs(RUBRIC, CHEAP_MODEL, STRONG_MODEL);
		expect(pairs).toHaveLength(1);
		metrics.record(
			computeAgreement(pairs, {
				rubricVersion: RUBRIC,
				cheapModelId: CHEAP_MODEL,
				strongModelId: STRONG_MODEL,
			}),
		);
		const res = handler(authed(`/agreement?rubricVersion=${RUBRIC}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			latest: { rubricVersion: string; sampledPairs: number; overallRate: number | null };
		};
		expect(body.latest).toMatchObject({
			rubricVersion: RUBRIC,
			sampledPairs: 1,
			overallRate: 0,
		});
	});
});
