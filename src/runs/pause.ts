/**
 * Blocking-question pause detector for batch runs (pl-0344 step 5 /
 * warren-2976).
 *
 * SPEC §11.O Plot-workbench loop: a batch agent can emit a
 * `question_posed` Plot event to halt and wait for a human reply. Warren
 * observes the Plot's event log and flips the still-running batch run
 * row to `paused`, persisting the targeted question's `at` timestamp on
 * `runs.paused_question_event_id`. When the human answers (via
 * `POST /plots/:id/questions/:event_id/answer`, a `question_answered`
 * event referencing the pose) OR the wall-clock pause budget elapses,
 * warren transitions the run back to `running` and respawns an agent
 * turn with the answer (or a timeout warning) folded into the prompt.
 * The respawned agent re-reads `.plot/` from disk — there is no
 * in-process state carry-over (SPEC §11.O.warren-2976 / mx-cd37 step 2).
 *
 * Shape (one tick):
 *
 *   1. Detect pauses. For every `running` batch run carrying a
 *      `plot_id`, open the Plot's event log via the typed reader seam
 *      and look for an `earliest unanswered question_posed`. If one
 *      exists, transition `running → paused`, stamp `paused_at` +
 *      `paused_question_event_id`, and emit a `pause.detected` system
 *      event on the run (mirrors the `plan_run.*` event-emit pattern
 *      from src/plan-runs/tick.ts — mx-fcc3f9 / mx-c88f10).
 *
 *   2. Detect resumes. For every `paused` run, re-read the Plot's
 *      event log:
 *        - If a `question_answered` references the paused question
 *          (`data.question_id === paused_question_event_id`), emit
 *          `pause.resumed`, transition `paused → running`, and call
 *          the `respawn` seam carrying the answer text.
 *        - Else if the budget (`agent.pauseTimeoutMs` per project,
 *          `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` fallback) has elapsed
 *          since `paused_at`, emit `pause.timed_out`, transition
 *          `paused → running`, and call `respawn` carrying a timeout
 *          warning (no answer).
 *
 * Single-flight tick wrapper mirrors `bootPlanRunCoordinator`
 * (mx-985743): a tick already in flight when the next interval fires
 * is dropped, so a slow tick degrades cadence but never duplicates
 * work. Per-run errors are caught so one bad row can't tear down the
 * loop.
 *
 * Non-batch runs (e.g. `mode === "conversation"`) are deliberately
 * excluded — the pause detector only touches `mode === "batch"` rows.
 *
 * The `respawn` seam is intentionally not wired to the live `spawnRun`
 * inside this module — the production wiring lives in
 * `src/server/main/index.ts`'s `bootPauseDetector` call. Keeping it as a
 * seam keeps the unit tests disk-free and mirrors the plan-run
 * coordinator's `spawn` injection.
 */

import { join } from "node:path";
import type { PlotEvent } from "@os-eco/plot-cli";
import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import { assertRunTransition } from "../db/repos/runs.ts";
import type { RunRow } from "../db/schema.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import { DEFAULT_AGENT_PAUSE_TIMEOUT_MS, type WarrenConfigCache } from "../warren-config/index.ts";

/** Event kind emitted on the run row when warren flips it `running → paused`. */
export const PAUSE_DETECTED_KIND = "pause.detected";
/** Event kind emitted when a paused run resumes via `question_answered`. */
export const PAUSE_RESUMED_KIND = "pause.resumed";
/** Event kind emitted when a paused run hits its `pauseTimeoutMs` budget. */
export const PAUSE_TIMED_OUT_KIND = "pause.timed_out";

/**
 * Reader seam for the Plot event log. Production opens a
 * `UserPlotClient` against the project's `.plot/` directory (read-only
 * actor) and snapshots `events()`. Tests substitute a stub keyed by
 * `plotId` so no disk / SQLite work happens in the unit suite.
 */
export interface PlotEventReader {
	read(input: {
		readonly plotDir: string;
		readonly plotId: string;
		readonly handle: string;
	}): Promise<readonly PlotEvent[]>;
}

export const defaultPlotEventReader: PlotEventReader = {
	async read({ plotDir, plotId, handle }) {
		const client = new UserPlotClient({
			dir: plotDir,
			actor: { kind: "user", handle, raw: `user:${handle}` },
		});
		try {
			return await client.get(plotId).events();
		} finally {
			client.close();
		}
	},
};

/**
 * Walk the event log and return the `at` of the earliest
 * `question_posed` whose pose has no later `question_answered` with
 * `data.question_id === pose.at`. Returns null when no unanswered
 * question exists.
 *
 * "Earliest" anchors a paused run to ONE question deterministically:
 * if the agent emits two questions in a row the second waits behind
 * the first. The resume tick handles only the anchored question; any
 * later poses will be picked up on the next pause-detect cycle once
 * the first is answered (and another `running → paused` round trip
 * happens).
 *
 * Pure / deterministic — exported for direct test coverage and for the
 * resolver-cached defense-in-depth path in `tickPauseDetector`.
 */
export function pickUnansweredQuestion(events: readonly PlotEvent[]): string | null {
	const answered = new Set<string>();
	for (const ev of events) {
		if (ev.type !== "question_answered") continue;
		const qid = (ev.data as { question_id?: unknown } | undefined)?.question_id;
		if (typeof qid === "string") answered.add(qid);
	}
	for (const ev of events) {
		if (ev.type !== "question_posed") continue;
		if (!answered.has(ev.at)) return ev.at;
	}
	return null;
}

/**
 * Find the `question_answered` event whose `data.question_id` matches
 * `questionEventId`, or null when none exists yet. Returns the first
 * match — the Plot lib enforces append-only semantics and the warren
 * handler-edge guard in `assertQuestionAnswerable` (mx-c4307b)
 * rejects double-answers, so at most one such event ever exists.
 */
export function findAnswerFor(
	events: readonly PlotEvent[],
	questionEventId: string,
): PlotEvent | null {
	for (const ev of events) {
		if (ev.type !== "question_answered") continue;
		const qid = (ev.data as { question_id?: unknown } | undefined)?.question_id;
		if (qid === questionEventId) return ev;
	}
	return null;
}

/**
 * Pull a string `text` field off a `question_answered` event's data
 * payload, or null when the payload was malformed / empty. Surfaces
 * cleanly to the respawn prompt — the agent gets either the answer
 * verbatim or no answer at all, never a runtime error.
 */
export function extractAnswerText(answer: PlotEvent): string | null {
	const text = (answer.data as { text?: unknown } | undefined)?.text;
	return typeof text === "string" && text !== "" ? text : null;
}

/* -------------------------------------------------------------------- */
/* Respawn seam                                                          */
/* -------------------------------------------------------------------- */

/**
 * Discriminator on `respawn` calls. `answered` carries the human's
 * reply verbatim; `timed_out` signals the budget elapsed with no
 * answer — the production seam folds a timeout warning into the
 * respawn prompt.
 */
export type RespawnReason =
	| { readonly kind: "answered"; readonly questionEventId: string; readonly answer: string | null }
	| { readonly kind: "timed_out"; readonly questionEventId: string };

export interface RespawnInput {
	readonly run: RunRow;
	readonly reason: RespawnReason;
}

/**
 * Seam for the actual "respawn the agent" side effect. Production
 * wires this to a fresh `spawnRun` against the same project + agent +
 * Plot with the answer (or timeout warning) folded into the prompt.
 * Failures are swallowed by the tick loop (logged) so a misbehaving
 * respawn cannot stall the resume transition or tear down the loop.
 */
export type RespawnFn = (input: RespawnInput) => Promise<void>;

/* -------------------------------------------------------------------- */
/* Coordinator deps + tick                                               */
/* -------------------------------------------------------------------- */

export interface PauseTickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface PauseTickDeps {
	readonly repos: Pick<Repos, "runs" | "events" | "projects">;
	readonly plotReader: PlotEventReader;
	readonly respawn: RespawnFn;
	/**
	 * Per-project config lookup. Used to resolve
	 * `agent.pauseTimeoutMs`; falls back to
	 * `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` when the project has no
	 * `.warren/config.yaml` or the field is omitted. Optional — tests
	 * that don't care about timeouts pass undefined and get the
	 * default budget.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	readonly handle?: string;
	readonly now?: () => Date;
	readonly logger?: PauseTickLogger;
}

export interface PauseTickResult {
	readonly paused: readonly { readonly runId: string; readonly questionEventId: string }[];
	readonly resumed: readonly {
		readonly runId: string;
		readonly questionEventId: string;
		readonly reason: "answered" | "timed_out";
	}[];
	readonly errors: readonly { readonly runId: string; readonly reason: string }[];
}

const DEFAULT_HANDLE = "operator";

/**
 * One pass of the pause coordinator. Each step is independent so
 * a transient error on one run never blocks the others.
 */
export async function tickPauseDetector(deps: PauseTickDeps): Promise<PauseTickResult> {
	const now = deps.now ?? (() => new Date());
	const handle = deps.handle ?? DEFAULT_HANDLE;
	const paused: { runId: string; questionEventId: string }[] = [];
	const resumed: { runId: string; questionEventId: string; reason: "answered" | "timed_out" }[] =
		[];
	const errors: { runId: string; reason: string }[] = [];

	// ----- 1. Pause-detect pass over running batch runs --------------
	let runningCandidates: RunRow[];
	try {
		runningCandidates = await deps.repos.runs.listByState("running");
	} catch (err) {
		errors.push({ runId: "<listByState:running>", reason: formatError(err) });
		runningCandidates = [];
	}
	for (const run of runningCandidates) {
		if (run.mode !== "batch") continue;
		if (run.plotId === null || run.plotId === "") continue;
		try {
			const events = await readPlot(deps, run, handle);
			const questionId = pickUnansweredQuestion(events);
			if (questionId === null) continue;
			await pauseRun(deps, run, questionId, now());
			paused.push({ runId: run.id, questionEventId: questionId });
		} catch (err) {
			errors.push({ runId: run.id, reason: formatError(err) });
			deps.logger?.error?.({ runId: run.id, reason: formatError(err) }, "pause.detect_failed");
		}
	}

	// ----- 2. Resume pass over paused runs ---------------------------
	let pausedCandidates: RunRow[];
	try {
		pausedCandidates = await deps.repos.runs.listByState("paused");
	} catch (err) {
		errors.push({ runId: "<listByState:paused>", reason: formatError(err) });
		pausedCandidates = [];
	}
	for (const run of pausedCandidates) {
		if (run.mode !== "batch") continue;
		if (run.plotId === null || run.plotId === "") continue;
		const questionId = run.pausedQuestionEventId;
		if (questionId === null) {
			// A `paused` row missing the targeted question id can't be
			// resumed deterministically — log and skip.
			deps.logger?.warn?.({ runId: run.id }, "pause.resume_skipped_missing_question_event_id");
			continue;
		}
		try {
			const events = await readPlot(deps, run, handle);
			const answer = findAnswerFor(events, questionId);
			if (answer !== null) {
				await resumeRun(deps, run, questionId, "answered", now(), extractAnswerText(answer));
				resumed.push({ runId: run.id, questionEventId: questionId, reason: "answered" });
				continue;
			}
			const budget = await resolveBudget(deps, run);
			const pausedAt = run.pausedAt === null ? null : Date.parse(run.pausedAt);
			if (pausedAt !== null && Number.isFinite(pausedAt)) {
				if (now().getTime() - pausedAt >= budget) {
					await resumeRun(deps, run, questionId, "timed_out", now(), null);
					resumed.push({ runId: run.id, questionEventId: questionId, reason: "timed_out" });
				}
			}
		} catch (err) {
			errors.push({ runId: run.id, reason: formatError(err) });
			deps.logger?.error?.({ runId: run.id, reason: formatError(err) }, "pause.resume_failed");
		}
	}

	return { paused, resumed, errors };
}

async function readPlot(
	deps: PauseTickDeps,
	run: RunRow,
	handle: string,
): Promise<readonly PlotEvent[]> {
	if (run.projectId === null || run.plotId === null) {
		// Defensive: callers gate on plotId/projectId already; an
		// out-of-band null landing here is a programmer error.
		return [];
	}
	const project = await deps.repos.projects.require(run.projectId);
	return deps.plotReader.read({
		plotDir: join(project.localPath, ".plot"),
		plotId: run.plotId,
		handle,
	});
}

async function pauseRun(
	deps: PauseTickDeps,
	run: RunRow,
	questionEventId: string,
	now: Date,
): Promise<void> {
	assertRunTransition(run.state, "paused");
	await deps.repos.runs.markPaused(run.id, questionEventId, now);
	await appendSystemEvent(deps, run.id, PAUSE_DETECTED_KIND, now, {
		plotId: run.plotId,
		questionEventId,
		pausedAt: now.toISOString(),
	});
	deps.logger?.info?.({ runId: run.id, plotId: run.plotId, questionEventId }, "pause.detected");
}

async function resumeRun(
	deps: PauseTickDeps,
	run: RunRow,
	questionEventId: string,
	reason: "answered" | "timed_out",
	now: Date,
	answer: string | null,
): Promise<void> {
	assertRunTransition(run.state, "running");
	await deps.repos.runs.markResumedFromPause(run.id);
	const kind = reason === "answered" ? PAUSE_RESUMED_KIND : PAUSE_TIMED_OUT_KIND;
	await appendSystemEvent(deps, run.id, kind, now, {
		plotId: run.plotId,
		questionEventId,
		reason,
		...(answer !== null ? { answer } : {}),
		resumedAt: now.toISOString(),
	});
	deps.logger?.info?.({ runId: run.id, plotId: run.plotId, questionEventId, reason }, kind);
	try {
		await deps.respawn({
			run: { ...run, state: "running", pausedAt: null, pausedQuestionEventId: null },
			reason:
				reason === "answered"
					? { kind: "answered", questionEventId, answer }
					: { kind: "timed_out", questionEventId },
		});
	} catch (err) {
		deps.logger?.error?.({ runId: run.id, reason: formatError(err) }, "pause.respawn_failed");
	}
}

async function appendSystemEvent(
	deps: PauseTickDeps,
	runId: string,
	kind: string,
	now: Date,
	payload: Record<string, unknown>,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	await deps.repos.events.append({
		runId,
		burrowEventSeq: seq,
		ts: now.toISOString(),
		kind,
		stream: "system",
		payload,
	});
}

async function resolveBudget(deps: PauseTickDeps, run: RunRow): Promise<number> {
	if (deps.warrenConfigs === undefined || run.projectId === null) {
		return DEFAULT_AGENT_PAUSE_TIMEOUT_MS;
	}
	try {
		const project = await deps.repos.projects.require(run.projectId);
		const cfg = await deps.warrenConfigs.get(run.projectId, project.localPath);
		const value = cfg.defaults?.agent?.pauseTimeoutMs;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		return DEFAULT_AGENT_PAUSE_TIMEOUT_MS;
	} catch {
		return DEFAULT_AGENT_PAUSE_TIMEOUT_MS;
	}
}

/* -------------------------------------------------------------------- */
/* Single-flight boot wrapper                                            */
/* -------------------------------------------------------------------- */

export type PauseDetectorTimerHandle = object;

export interface BootPauseDetectorInput extends PauseTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => PauseDetectorTimerHandle;
	readonly clearInterval?: (handle: PauseDetectorTimerHandle) => void;
}

export interface PauseDetectorHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<PauseTickResult | null>;
	/** Diagnostic — number of completed ticks (success or skip). */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol("pause-detector-noop-handle") as unknown as PauseDetectorTimerHandle;

/**
 * Boot the recurring pause-detect tick. Single-flight wrapper drops
 * overlapping ticks instead of stacking them — mirrors
 * `bootPlanRunCoordinator` so the lifecycle semantics are identical
 * for operators reading logs.
 */
export function bootPauseDetector(input: BootPauseDetectorInput): PauseDetectorHandle {
	const setIntervalFn: (cb: () => void, ms: number) => PauseDetectorTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as PauseDetectorTimerHandle);
	const clearIntervalFn: (handle: PauseDetectorTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<PauseTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<PauseTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info?.({}, "pause.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await tickPauseDetector(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.({ reason: formatError(err) }, "pause.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: PauseDetectorTimerHandle =
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
