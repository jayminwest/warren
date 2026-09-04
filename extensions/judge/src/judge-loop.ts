/**
 * The judge loop (plan pl-17ca step 5): a bounded agent loop over the pi
 * SDK that resolves to a wire.ts-validated verdict or an unjudged marker
 * with a reason — nothing else, never a partial write.
 *
 * The loop is SDK-agnostic: `judgeRun` drives a {@link JudgeSessionFactory}
 * seam, and the real pi adapter lives in `pi-session.ts`. The session is
 * created with the built-in coding toolset stripped (`noTools: "builtin"`)
 * and exactly the three tools from `judge-tools.ts`, so the judge holds no
 * mutation capability of any kind (agent-analytics §12.2).
 *
 * Verdict emission is PROMPT-enforced, not provider-enforced: the pi
 * session API surfaces no provider tool_choice forcing, so `report_verdict`
 * carries the mandate in its promptGuidelines, and a judgment that ends in
 * plain text without calling it consumes the bounded retry budget
 * (`JUDGE_MAX_RETRIES`, one fresh session per attempt).
 *
 * Per-judgment accounting: every attempt's `getSessionStats()` aggregates
 * into {@link JudgmentStats} (tokens + cost per provider/model), and the
 * final cost, pages read, and page-cap flag land in the verdict's
 * provenance. The per-judgment cap is enforced twice (warren-9a34): live
 * inside an attempt — once accrued cost reaches the cap, `page_events`
 * stops serving transcript and tells the model to report from what it has,
 * so a successful attempt overshoots by at most one model turn — and
 * between attempts, where a capped-out judgment that still holds no verdict
 * resolves as `budget_exceeded` rather than burning another attempt.
 */

import type { WarrenClient } from "./client.ts";
import { createJudgeTools, type JudgeToolSpec } from "./judge-tools.ts";
import { renderJudgeSystemPrompt } from "./rubric.ts";
import type { UnjudgedReason } from "./verdict-store.ts";
import { type JudgeVerdict, validateVerdict } from "./wire.ts";

/** Token + cost accounting for one session, from `getSessionStats()`. */
export interface SessionStatsSnapshot {
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	/** USD cost of the session. */
	readonly costUsd: number;
}

/**
 * The session seam. Production wires the pi SDK adapter (`pi-session.ts`);
 * tests wire a stub. `dispose` releases whatever the adapter holds.
 */
export interface JudgeSession {
	prompt(text: string): Promise<void>;
	/** Resolve when the agent loop has settled (verdict called or plain-text end). */
	waitForIdle(): Promise<void>;
	getSessionStats(): SessionStatsSnapshot;
	/**
	 * The provider error that ended the most recent turn, or null when the
	 * turn ended normally. A provider failure (an expired key, a 401, a
	 * model the account cannot reach) does not throw: the agent loop encodes
	 * it on the final assistant message and goes idle, so without this the
	 * loop cannot tell a dead credential from a model that talked instead of
	 * calling report_verdict.
	 */
	getLastError(): string | null;
	dispose(): void;
}

/** Builds one session per judgment attempt: rubric prompt + the three tools. */
export type JudgeSessionFactory = (opts: {
	systemPrompt: string;
	tools: readonly JudgeToolSpec[];
}) => Promise<JudgeSession>;

/** Default malformed/missing-verdict retry count (one run + N retries). */
export const DEFAULT_MAX_RETRIES = 2;
/** Default hard cap on events pages per judgment (JUDGE_MAX_PAGES). */
export const DEFAULT_MAX_PAGES = 40;
/** Default events page size (JUDGE_EVENTS_PAGE_SIZE). */
export const DEFAULT_EVENTS_PAGE_SIZE = 200;

export interface JudgeRunOptions {
	readonly client: WarrenClient;
	readonly runId: string;
	readonly provider: string;
	readonly model: string;
	readonly rubricVersion: string;
	readonly sessionFactory: JudgeSessionFactory;
	/** Retries allowed after the first failed judgment (default 2). */
	readonly maxRetries?: number;
	/** Hard events-page cap per judgment (default {@link DEFAULT_MAX_PAGES}). */
	readonly maxPages?: number;
	/** Default events page size (default {@link DEFAULT_EVENTS_PAGE_SIZE}). */
	readonly eventsPageSize?: number;
	/**
	 * Per-judgment USD cap. When accrued cost across attempts reaches it the
	 * loop stops with `budget_exceeded` rather than spending another attempt.
	 */
	readonly maxCostUsdPerJudgment?: number;
	readonly now?: () => Date;
}

/** Aggregated accounting for one judgment (across retries). */
export interface JudgmentStats {
	readonly attempts: number;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly costUsd: number;
	/** Events pages served across all attempts (0 is a valid, cheap judgment). */
	readonly pagesRead: number;
	/** True when any attempt hit the hard events-page cap. */
	readonly pageCapHit: boolean;
}

/**
 * The only two resolutions a judgment has (§12.5): a validated verdict, or
 * an unjudged marker with a machine-readable reason. Never a partial write.
 */
export type JudgeOutcome =
	| { readonly kind: "verdict"; readonly verdict: JudgeVerdict; readonly stats: JudgmentStats }
	| {
			readonly kind: "unjudged";
			readonly reason: UnjudgedReason;
			readonly detail: string;
			readonly stats: JudgmentStats;
	  };

function emptyStats(): {
	attempts: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	costUsd: number;
	pagesRead: number;
	pageCapHit: boolean;
} {
	return {
		attempts: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		costUsd: 0,
		pagesRead: 0,
		pageCapHit: false,
	};
}

function toJudgmentStats(stats: ReturnType<typeof emptyStats>): JudgmentStats {
	return {
		attempts: stats.attempts,
		tokens: { ...stats.tokens },
		costUsd: stats.costUsd,
		pagesRead: stats.pagesRead,
		pageCapHit: stats.pageCapHit,
	};
}

/**
 * Judge one run. Resolves exactly one {@link JudgeOutcome}; the verdict arm
 * re-validates the assembled verdict against wire.ts before returning, so a
 * caller can hand `verdict` straight to the append-only store.
 */
export async function judgeRun(opts: JudgeRunOptions): Promise<JudgeOutcome> {
	const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
	const maxAttempts = Math.max(1, maxRetries + 1);
	const stats = emptyStats();
	const systemPrompt = renderJudgeSystemPrompt();
	const userPrompt =
		`Judge run ${opts.runId} under rubric v1. Begin with get_run_facts, ` +
		"then page_events through the transcript — including its tail, where " +
		"the reap.* events record the actual outcome — and end by calling " +
		"report_verdict exactly once.";

	let lastFailure: { reason: "malformed_verdict" | "judge_error"; detail: string } | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		stats.attempts = attempt;
		// Live accrued cost: prior attempts (stats) + the in-flight session.
		// page_events reads it through this closure to gate on the cap
		// mid-attempt (warren-9a34); the session lands after tool creation,
		// so the reference is deliberately mutable.
		let liveSession: JudgeSession | null = null;
		const { tools, state } = createJudgeTools({
			client: opts.client,
			runId: opts.runId,
			eventsPageSize: opts.eventsPageSize ?? DEFAULT_EVENTS_PAGE_SIZE,
			maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES,
			...(opts.maxCostUsdPerJudgment !== undefined
				? { maxCostUsd: opts.maxCostUsdPerJudgment }
				: {}),
			getAccruedCostUsd: () => {
				if (liveSession === null) return stats.costUsd;
				try {
					return stats.costUsd + liveSession.getSessionStats().costUsd;
				} catch {
					return stats.costUsd;
				}
			},
		});
		let session: JudgeSession | null = null;
		let attemptError: unknown = null;
		let providerError: string | null = null;
		try {
			session = await opts.sessionFactory({ systemPrompt, tools });
			liveSession = session;
			await session.prompt(userPrompt);
			await session.waitForIdle();
		} catch (error) {
			attemptError = error;
		} finally {
			if (session !== null) {
				try {
					const snap = session.getSessionStats();
					stats.tokens = {
						input: stats.tokens.input + snap.tokens.input,
						output: stats.tokens.output + snap.tokens.output,
						cacheRead: stats.tokens.cacheRead + snap.tokens.cacheRead,
						cacheWrite: stats.tokens.cacheWrite + snap.tokens.cacheWrite,
						total: stats.tokens.total + snap.tokens.total,
					};
					stats.costUsd += snap.costUsd;
				} catch {
					// Stats are accounting, not the judgment: a stats-capture
					// failure never turns a good verdict into an unjudged marker.
				}
				try {
					// Read before dispose, and in its own try for the same reason
					// the stats capture has one.
					providerError = session.getLastError();
				} catch {
					providerError = null;
				}
				session.dispose();
			}
		}
		stats.pagesRead += state.pagesRead;
		stats.pageCapHit = stats.pageCapHit || state.pageCapHit;

		if (state.reportedVerdict !== null) {
			const now = opts.now ?? (() => new Date());
			const verdict = validateVerdict({
				runId: opts.runId,
				assignments: state.reportedVerdict.assignments,
				provenance: {
					provider: opts.provider,
					model: opts.model,
					rubricVersion: opts.rubricVersion,
					judgedAt: now().toISOString(),
					costUsd: stats.costUsd,
					pagesRead: stats.pagesRead,
					pageCapHit: stats.pageCapHit,
				},
			});
			return { kind: "verdict", verdict, stats: toJudgmentStats(stats) };
		}

		if (attemptError !== null) {
			lastFailure = {
				reason: "judge_error",
				detail:
					attemptError instanceof Error ? attemptError.message : String(attemptError),
			};
		} else if (providerError !== null) {
			// A retry against the same dead credential cannot succeed, and each
			// one is billed. End the judgment on the provider's own words.
			return {
				kind: "unjudged",
				reason: "judge_error",
				detail: `provider error on attempt ${attempt}, not retried: ${providerError}`,
				stats: toJudgmentStats(stats),
			};
		} else {
			lastFailure = {
				reason: "malformed_verdict",
				detail:
					"judgment attempt ended without calling report_verdict " +
					"(plain-text end counts against the retry budget)",
			};
		}

		const cap = opts.maxCostUsdPerJudgment;
		if (cap !== undefined && stats.costUsd >= cap) {
			return {
				kind: "unjudged",
				reason: "budget_exceeded",
				detail:
					`accrued cost $${stats.costUsd.toFixed(4)} reached the ` +
					`per-judgment cap $${cap.toFixed(4)} after ${attempt} attempt(s)`,
				stats: toJudgmentStats(stats),
			};
		}
	}

	const failure = lastFailure ?? {
		reason: "malformed_verdict" as const,
		detail: "no attempt ran",
	};
	return {
		kind: "unjudged",
		reason: failure.reason,
		detail: `exhausted ${maxAttempts} attempt(s): ${failure.detail}`,
		stats: toJudgmentStats(stats),
	};
}
