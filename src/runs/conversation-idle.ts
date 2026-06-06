/**
 * Conversation idle-timeout coordinator (warren-005d / LEVERET.md §0.4 /
 * §0.14, pl-d2d9 build-phase 2).
 *
 * A mode:"conversation" anchoring run stays non-terminal across turns: the
 * burrow-side pi-chat agent suppresses the per-turn `agent_end` terminal
 * envelope, so the run never finalizes on its own (warren-c770 exempts it
 * from the watchdog / crash-recovery / reap workspace-destroy guards — an
 * idle conversation run is healthy, not hung). Something therefore has to own
 * the deadline that closes out an abandoned conversation's compute, and that
 * is this coordinator.
 *
 * Crucially this finalizes ONLY the anchoring RUN — it does NOT close the
 * conversation. The `conversations` row stays `status='active'`, the Plot and
 * the `messages` transcript persist, and a later re-wake (warren-6ccf) spawns
 * a fresh mode:"conversation" run that replays the transcript into a new pi
 * session. Idle-finalize just reclaims the sandbox/compute, it never destroys
 * conversational state.
 *
 * Shape (one tick), mirroring `bootPauseDetector` (src/runs/pause.ts):
 *
 *   1. Ask the `IdleConversationReader` seam for the set of `active`
 *      conversations whose anchoring run is still `running`, each carrying
 *      `last_activity_at` + the anchoring `run_id` + `project_id`.
 *   2. For each candidate, resolve the per-project budget
 *      (`conversation.idleTimeoutMs`, falling back to
 *      `DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS`). If
 *      `now - last_activity_at >= budget`, finalize the anchoring run
 *      `running → succeeded` and emit a `conversation.idle_finalized` system
 *      event on the run. The conversation row is left untouched.
 *
 * The reader is a seam, not a direct `ConversationsRepo` call, so the unit
 * suite stays disk-free and table-free and the production wiring (querying
 * the conversations/messages tables landed by warren-0b91, joined against the
 * anchoring run) can slot in at boot without touching this module — exactly
 * how `pause.ts` keeps its `respawn` / `plotReader` seams out of the live
 * `spawnRun` path. The single-flight boot wrapper mirrors
 * `bootPauseDetector`: an overlapping tick is dropped, never stacked.
 */

import type { Repos } from "../db/repos/index.ts";
import { assertRunTransition } from "../db/repos/runs.ts";
import {
	DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS,
	type WarrenConfigCache,
} from "../warren-config/index.ts";

/** Event kind emitted on the anchoring run when warren idle-finalizes it. */
export const CONVERSATION_IDLE_FINALIZED_KIND = "conversation.idle_finalized";

/**
 * One idle-conversation candidate: an `active` conversation whose anchoring
 * run is still `running`. Production builds these by joining the
 * `conversations` table (warren-0b91) against the anchoring run row; the unit
 * suite hands back plain literals.
 */
export interface IdleConversationCandidate {
	readonly conversationId: string;
	/** The anchoring (mode:"conversation") run to finalize. Must be `running`. */
	readonly runId: string;
	/** Project that owns the conversation; null when unattributable. */
	readonly projectId: string | null;
	/** ISO-8601 `conversations.last_activity_at`. */
	readonly lastActivityAt: string;
}

/**
 * Reader seam yielding the idle-finalize candidate set for one tick.
 * Production snapshots `active` conversations with a `running` anchoring run;
 * tests substitute a stub.
 */
export interface IdleConversationReader {
	read(): Promise<readonly IdleConversationCandidate[]>;
}

export interface ConversationIdleTickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ConversationIdleTickDeps {
	readonly repos: Pick<Repos, "runs" | "events" | "projects">;
	readonly reader: IdleConversationReader;
	/**
	 * Per-project config lookup, used to resolve
	 * `conversation.idleTimeoutMs`; falls back to
	 * `DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS` when the project has no
	 * `.warren/config.yaml` or the field is omitted. Optional — tests that
	 * don't care about per-project budgets pass undefined and get the default.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	readonly now?: () => Date;
	readonly logger?: ConversationIdleTickLogger;
}

export interface ConversationIdleTickResult {
	readonly finalized: readonly { readonly conversationId: string; readonly runId: string }[];
	readonly errors: readonly { readonly conversationId: string; readonly reason: string }[];
}

/**
 * One pass of the idle-timeout coordinator. Each candidate is handled
 * independently so a transient error on one conversation never blocks the
 * others.
 */
export async function tickConversationIdleDetector(
	deps: ConversationIdleTickDeps,
): Promise<ConversationIdleTickResult> {
	const now = deps.now ?? (() => new Date());
	const finalized: { conversationId: string; runId: string }[] = [];
	const errors: { conversationId: string; reason: string }[] = [];

	let candidates: readonly IdleConversationCandidate[];
	try {
		candidates = await deps.reader.read();
	} catch (err) {
		errors.push({ conversationId: "<reader.read>", reason: formatError(err) });
		return { finalized, errors };
	}

	for (const candidate of candidates) {
		try {
			const lastActivity = Date.parse(candidate.lastActivityAt);
			if (!Number.isFinite(lastActivity)) {
				deps.logger?.warn?.(
					{ conversationId: candidate.conversationId, lastActivityAt: candidate.lastActivityAt },
					"conversation.idle_skipped_bad_timestamp",
				);
				continue;
			}
			const budget = await resolveIdleBudget(deps, candidate.projectId);
			if (now().getTime() - lastActivity < budget) continue;
			const didFinalize = await finalizeIdleRun(deps, candidate, now());
			if (didFinalize) {
				finalized.push({ conversationId: candidate.conversationId, runId: candidate.runId });
			}
		} catch (err) {
			errors.push({ conversationId: candidate.conversationId, reason: formatError(err) });
			deps.logger?.error?.(
				{ conversationId: candidate.conversationId, reason: formatError(err) },
				"conversation.idle_finalize_failed",
			);
		}
	}

	return { finalized, errors };
}

async function finalizeIdleRun(
	deps: ConversationIdleTickDeps,
	candidate: IdleConversationCandidate,
	now: Date,
): Promise<boolean> {
	const run = await deps.repos.runs.require(candidate.runId);
	// Defensive: the reader promises a `running` anchoring run, but the row may
	// have transitioned between snapshot and finalize. Skip non-running rows
	// rather than throwing an invalid-transition error.
	if (run.state !== "running") {
		deps.logger?.warn?.(
			{ conversationId: candidate.conversationId, runId: candidate.runId, state: run.state },
			"conversation.idle_skipped_not_running",
		);
		return false;
	}
	assertRunTransition(run.state, "succeeded");
	await deps.repos.runs.finalize(run.id, "succeeded", now);
	await appendSystemEvent(deps, run.id, CONVERSATION_IDLE_FINALIZED_KIND, {
		conversationId: candidate.conversationId,
		lastActivityAt: candidate.lastActivityAt,
		finalizedAt: now.toISOString(),
	});
	deps.logger?.info?.(
		{ conversationId: candidate.conversationId, runId: run.id },
		CONVERSATION_IDLE_FINALIZED_KIND,
	);
	return true;
}

async function appendSystemEvent(
	deps: ConversationIdleTickDeps,
	runId: string,
	kind: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	await deps.repos.events.append({
		runId,
		burrowEventSeq: seq,
		ts: new Date().toISOString(),
		kind,
		stream: "system",
		payload,
	});
}

async function resolveIdleBudget(
	deps: ConversationIdleTickDeps,
	projectId: string | null,
): Promise<number> {
	if (deps.warrenConfigs === undefined || projectId === null) {
		return DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS;
	}
	try {
		const project = await deps.repos.projects.require(projectId);
		const cfg = await deps.warrenConfigs.get(projectId, project.localPath);
		const value = cfg.defaults?.conversation?.idleTimeoutMs;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		return DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS;
	} catch {
		return DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS;
	}
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------- */
/* Single-flight boot wrapper (mirrors bootPauseDetector)                */
/* -------------------------------------------------------------------- */

export type ConversationIdleTimerHandle = object;

export interface BootConversationIdleDetectorInput extends ConversationIdleTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => ConversationIdleTimerHandle;
	readonly clearInterval?: (handle: ConversationIdleTimerHandle) => void;
}

export interface ConversationIdleDetectorHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<ConversationIdleTickResult | null>;
	/** Diagnostic — number of completed ticks (success or skip). */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol(
	"conversation-idle-detector-noop-handle",
) as unknown as ConversationIdleTimerHandle;

/**
 * Boot the recurring idle-finalize tick. Single-flight wrapper drops
 * overlapping ticks instead of stacking them — mirrors `bootPauseDetector`
 * so the lifecycle semantics are identical for operators reading logs.
 */
export function bootConversationIdleDetector(
	input: BootConversationIdleDetectorInput,
): ConversationIdleDetectorHandle {
	const setIntervalFn: (cb: () => void, ms: number) => ConversationIdleTimerHandle =
		input.setInterval ??
		((cb, ms) => globalThis.setInterval(cb, ms) as ConversationIdleTimerHandle);
	const clearIntervalFn: (handle: ConversationIdleTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<ConversationIdleTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<ConversationIdleTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info?.({}, "conversation.idle_tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await tickConversationIdleDetector(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.({ reason: formatError(err) }, "conversation.idle_tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: ConversationIdleTimerHandle =
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
