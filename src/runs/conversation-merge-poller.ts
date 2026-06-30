/**
 * Send-off PR-merge poller (warren-b872, build-phase 5).
 *
 * No webhooks in v1. When the operator sends a leveret conversation to the
 * planner (`POST /conversations/:id/send-off`, warren-756d), warren opens a
 * plotSync PR carrying only the plot-state update, closes the conversation,
 * and persists the submitted PR ref + `plot_id` + planner agent on the
 * conversation row. The operator then MERGES that PR by hand (accepted v1
 * tradeoff). This poller is the other half: it polls each sent-off-but-not-
 * yet-dispatched conversation's PR until merged, then AUTO-DISPATCHES a
 * separate planner run (the built-in `planner`, in its own burrow) keyed on
 * the conversation's `plot_id`. The planner's fresh clone now contains the
 * merged intent; its prompt forbids self-dispatch (no `POST /runs`, no
 * `POST /plan-runs`), so it emits an `sd` plan and stops.
 *
 * Shape (one tick):
 *
 *   1. List closed conversations carrying a `submitted_pr_url` whose
 *      `planner_run_id` is still null (`listAwaitingPlannerDispatch`).
 *   2. For each, poll the PR's merge state via the retry-aware
 *      `PrMergeChecker` (REUSED from src/plan-runs/pr-merge.ts — same helper
 *      the plan-run coordinator's merge gate uses). Only a `merged` result
 *      proceeds; `open` stays waiting, `closed_unmerged` / fatal HTTP errors
 *      are logged and left for the operator (no auto-fail in v1).
 *   3. On merge, dispatch the planner via the injectable `dispatch` seam
 *      (production wiring wraps `spawnRun` + `bridges.start`; the unit suite
 *      hands back a literal run id), then stamp `planner_run_id` on the
 *      conversation via the single-shot `recordPlannerDispatch` guard and
 *      emit a `conversation.planner_dispatched` system event on the new run.
 *
 * Mirrors the seam discipline + single-flight boot wrapper of
 * `src/runs/pause.ts`'s `bootPauseDetector` (mx-fcc3f9 / mx-985743): the
 * `dispatch` side effect is a seam so the tick stays disk- and burrow-free in
 * tests, and an in-flight tick is dropped rather than stacked. Per-row errors
 * are caught so one bad PR can't tear down the loop.
 *
 * Single-shot guard: `recordPlannerDispatch` only writes when
 * `planner_run_id` is still null, so a second poll tick can never
 * double-dispatch. The narrow window where a dispatch spawns but the record
 * write crashes before committing would re-dispatch on the next tick — an
 * accepted v1 edge (the operator gets one extra planner run, never a missed
 * one).
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PrMergeChecker } from "../plan-runs/pr-merge.ts";

/** Default planner agent when a conversation send-off didn't pin one. */
export const DEFAULT_PLANNER_AGENT = "planner";

/** System event emitted on the freshly-dispatched planner run. */
export const CONVERSATION_PLANNER_DISPATCHED_KIND = "conversation.planner_dispatched" as const;

/**
 * Seed prompt handed to the auto-dispatched planner run. The planner's own
 * system body (composed by `spawnRun`) already pins its scout + plan-writer
 * contract; this is just the user-facing first turn pointing it at the
 * freshly-merged Plot intent. Pure / deterministic so it snapshots in tests.
 */
export function buildPlannerDispatchPrompt(plotId: string): string {
	return [
		`The Plot intent for \`${plotId}\` was just finalized in a leveret conversation`,
		"and merged into the default branch — your clone contains it now.",
		"",
		"Read the Plot intent (goal, non_goals, constraints, success_criteria),",
		"ground a plan in the repo, and produce a structured seeds plan via",
		"`sd plan prompt` → `sd plan submit`. Do NOT dispatch any runs — surface the",
		"plan id and child seed ids back to the operator when you're done.",
	].join("\n");
}

/* -------------------------------------------------------------------- */
/* Dispatch seam                                                         */
/* -------------------------------------------------------------------- */

/** Conversation-specific inputs the dispatch seam needs to spawn the planner. */
export interface PlannerDispatchInput {
	readonly conversationId: string;
	readonly projectId: string;
	readonly plotId: string;
	readonly plannerAgent: string;
}

export interface PlannerDispatchResult {
	/** The freshly-spawned planner run id. */
	readonly runId: string;
}

/**
 * Seam for the "spawn the planner run" side effect. Production wires this to a
 * fresh `spawnRun` (planner agent, its own burrow, keyed on `plot_id`) plus
 * `bridges.start`; tests hand back a literal run id. Modeled on `pause.ts`'s
 * `RespawnFn`.
 */
export type PlannerDispatchFn = (input: PlannerDispatchInput) => Promise<PlannerDispatchResult>;

/* -------------------------------------------------------------------- */
/* Coordinator deps + tick                                               */
/* -------------------------------------------------------------------- */

export interface MergePollLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface MergePollTickDeps {
	readonly repos: Pick<Repos, "conversations" | "events">;
	readonly checkPrMerged: PrMergeChecker;
	readonly dispatch: PlannerDispatchFn;
	readonly now?: () => Date;
	readonly logger?: MergePollLogger;
}

export interface MergePollTickResult {
	readonly dispatched: readonly {
		readonly conversationId: string;
		readonly plotId: string;
		readonly plannerRunId: string;
	}[];
	readonly waiting: readonly { readonly conversationId: string; readonly reason: string }[];
	readonly errors: readonly { readonly conversationId: string; readonly reason: string }[];
}

/**
 * One pass of the merge poller. Each conversation is independent so a
 * transient error on one PR never blocks the others.
 */
export async function tickConversationMergePoller(
	deps: MergePollTickDeps,
): Promise<MergePollTickResult> {
	const now = deps.now ?? (() => new Date());
	const dispatched: { conversationId: string; plotId: string; plannerRunId: string }[] = [];
	const waiting: { conversationId: string; reason: string }[] = [];
	const errors: { conversationId: string; reason: string }[] = [];

	let candidates: Awaited<ReturnType<Repos["conversations"]["listAwaitingPlannerDispatch"]>>;
	try {
		candidates = await deps.repos.conversations.listAwaitingPlannerDispatch();
	} catch (err) {
		return {
			dispatched,
			waiting,
			errors: [{ conversationId: "<listAwaitingPlannerDispatch>", reason: formatError(err) }],
		};
	}

	for (const conv of candidates) {
		try {
			await pollOne(deps, conv, now, { dispatched, waiting });
		} catch (err) {
			errors.push({ conversationId: conv.id, reason: formatError(err) });
			deps.logger?.error?.(
				{ conversationId: conv.id, reason: formatError(err) },
				"merge_poller.tick_failed",
			);
		}
	}

	return { dispatched, waiting, errors };
}

interface PollSinks {
	readonly dispatched: { conversationId: string; plotId: string; plannerRunId: string }[];
	readonly waiting: { conversationId: string; reason: string }[];
}

async function pollOne(
	deps: MergePollTickDeps,
	conv: Awaited<ReturnType<Repos["conversations"]["listAwaitingPlannerDispatch"]>>[number],
	now: () => Date,
	sinks: PollSinks,
): Promise<void> {
	const prUrl = conv.submittedPrUrl;
	const plotId = conv.plotId;
	if (prUrl === null || prUrl === "") return; // defensive; the list filters these out
	if (plotId === null || plotId === "" || conv.projectId === null) {
		sinks.waiting.push({ conversationId: conv.id, reason: "missing_plot_or_project" });
		return;
	}

	const polled = await deps.checkPrMerged(prUrl);
	if (polled.kind !== "merged") {
		sinks.waiting.push({ conversationId: conv.id, reason: polled.kind });
		if (polled.kind === "closed_unmerged" || polled.kind === "http_error") {
			deps.logger?.warn?.(
				{ conversationId: conv.id, prUrl, kind: polled.kind },
				"merge_poller.pr_not_mergeable",
			);
		}
		return;
	}

	const plannerAgent =
		conv.plannerAgent !== null && conv.plannerAgent !== ""
			? conv.plannerAgent
			: DEFAULT_PLANNER_AGENT;
	const result = await deps.dispatch({
		conversationId: conv.id,
		projectId: conv.projectId,
		plotId,
		plannerAgent,
	});

	const recorded = await deps.repos.conversations.recordPlannerDispatch(
		conv.id,
		result.runId,
		now(),
	);
	if (recorded === null) {
		// A concurrent / crash-recovered tick already stamped a dispatch; skip
		// the event so the trail stays single-shot. (The duplicate planner run,
		// if any, is the accepted v1 edge — see module header.)
		deps.logger?.warn?.(
			{ conversationId: conv.id, runId: result.runId },
			"merge_poller.dispatch_already_recorded",
		);
		return;
	}

	await appendDispatchEvent(deps, result.runId, {
		conversationId: conv.id,
		plotId,
		plannerAgent,
		prUrl,
		dispatchedAt: now().toISOString(),
	});
	sinks.dispatched.push({ conversationId: conv.id, plotId, plannerRunId: result.runId });
	deps.logger?.info?.(
		{ conversationId: conv.id, plotId, plannerRunId: result.runId, plannerAgent },
		"merge_poller.planner_dispatched",
	);
}

async function appendDispatchEvent(
	deps: Pick<MergePollTickDeps, "repos">,
	runId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		const seq = ((await deps.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await deps.repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date().toISOString(),
			kind: CONVERSATION_PLANNER_DISPATCHED_KIND,
			stream: "system",
			payload,
		});
	} catch {
		// Logging-only trail; a failure here must not unwind a successful
		// dispatch. Mirrors appendRewakeEvent in conversation-rewake.ts.
	}
}

/* -------------------------------------------------------------------- */
/* Single-flight boot wrapper                                            */
/* -------------------------------------------------------------------- */

export type MergePollTimerHandle = object;

export interface BootMergePollerInput extends MergePollTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => MergePollTimerHandle;
	readonly clearInterval?: (handle: MergePollTimerHandle) => void;
}

export interface MergePollerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<MergePollTickResult | null>;
	/** Diagnostic — number of completed ticks. */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol("merge-poller-noop-handle") as unknown as MergePollTimerHandle;

/**
 * Boot the recurring merge-poll tick. Single-flight wrapper drops overlapping
 * ticks instead of stacking them — mirrors `bootPauseDetector` so the
 * lifecycle semantics are identical for operators reading logs.
 */
export function bootConversationMergePoller(input: BootMergePollerInput): MergePollerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => MergePollTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as MergePollTimerHandle);
	const clearIntervalFn: (handle: MergePollTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<MergePollTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<MergePollTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info?.({}, "merge_poller.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await tickConversationMergePoller(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.({ reason: formatError(err) }, "merge_poller.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: MergePollTimerHandle =
		input.disabled === true ? NOOP_HANDLE : setIntervalFn(() => void fire(), input.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// already logged in fire()
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
