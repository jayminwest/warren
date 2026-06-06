/**
 * Conversation re-wake primitive (warren-6ccf / LEVERET.md §0.4 / §0.2 /
 * pl-d2d9 build-phase 2).
 *
 * When the operator returns to an `active` conversation whose anchoring run
 * has gone terminal — idle-finalized (warren-005d), crash-recovered, or
 * force-failed — there is no live pi session to talk to anymore, but the
 * conversation itself is NOT closed: the `conversations` row stays
 * `status='active'`, the Plot persists, and the full turn-by-turn transcript
 * lives in the `messages` table. Re-wake spawns a *fresh* mode:"conversation"
 * run that REPLAYS that transcript into a brand-new pi session, then rotates
 * `conversations.anchoring_run_id` to point at the new run.
 *
 * Crucially, re-wake does NOT resume the old burrow / `.pi/sessions` state —
 * v1 needs no `pi --session` resume. The new session is seeded purely from the
 * DB transcript, so it survives the old workspace being destroyed at reap
 * (warren-c770 exempts conversation runs from reap workspace-destroy, but a
 * crash or operator teardown can still reclaim it). Token cost grows with
 * transcript length; that is an accepted v1 trade-off.
 *
 * Shape (one re-wake):
 *
 *   1. Read the conversation record via the `ConversationRewakeReader` seam.
 *      `null` → NotFound. A `closed` conversation cannot be re-woken
 *      (ValidationError) — only `active` ones with a dead anchoring run.
 *   2. Resolve the prior anchoring run. `anchoring_run_id` must be set (v1
 *      always sets it at conversation-create) and the run row must exist; its
 *      `agent_name` + `plot_id` seed the new run. If the prior run is NOT
 *      terminal it is still live — there is nothing to re-wake, so we refuse
 *      (ValidationError) rather than spawning a duplicate session.
 *   3. Read the full transcript (oldest-first) via the reader seam and render
 *      it into a `<conversation_transcript>` replay block with
 *      `buildRewakePrompt`. The agent's `system` body is prepended by
 *      `composeDispatchPrompt` inside `spawnRun`, so this is just the
 *      user-facing payload.
 *   4. Spawn a fresh mode:"conversation" run via the injectable `spawner`
 *      seam (defaults to the real `spawnRun`). Every reusable spawn knob is
 *      forwarded verbatim — re-wake duplicates none of the burrow plumbing.
 *   5. Rotate `conversations.anchoring_run_id` to the new run via the
 *      `ConversationAnchorRotator` seam, and emit a
 *      `conversation.rewake_replayed` system event on the new run carrying the
 *      prior run id + replayed message count.
 *
 * Mirrors the seam discipline of `conversation-idle.ts` and the spawn-forward
 * discipline of `interactive.ts`: the reader / rotator are seams (production
 * queries the warren-0b91 `conversations` + `messages` tables; the unit suite
 * hands back literals) so this module needs neither disk nor those tables to
 * be exercised, and the live HTTP wiring (warren-af15) slots the repo-backed
 * implementations in at the boundary.
 */

import { isTerminalRunState } from "../client/types.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { RunRow } from "../db/schema.ts";
import { type SpawnRunInput, type SpawnRunResult, spawnRun } from "./spawn/index.ts";

/** Event kind emitted on the freshly-spawned run when re-wake replays a transcript. */
export const CONVERSATION_REWAKE_REPLAYED_KIND = "conversation.rewake_replayed" as const;

/** Conversation lifecycle status. Mirrors the warren-0b91 `conversations.status` column. */
export type ConversationStatus = "active" | "closed";

/** Role discriminator for a transcript message. Mirrors `messages.role`. */
export type TranscriptRole = "user" | "assistant" | "system" | "tool";

/**
 * The slice of a `conversations` row re-wake needs. Production reads this from
 * the warren-0b91 table; tests hand back a literal.
 */
export interface ConversationRecord {
	readonly id: string;
	/** Owning project (REQUIRED in v1; the column is non-null). */
	readonly projectId: string | null;
	/** Plot the conversation is bound to (v1 always sets it). */
	readonly plotId: string | null;
	/** Anchoring run pointer — rotates on every re-wake. */
	readonly anchoringRunId: string | null;
	readonly status: ConversationStatus;
}

/** One transcript turn pulled from the `messages` table, oldest-first. */
export interface TranscriptMessage {
	readonly seq: number;
	readonly role: TranscriptRole;
	readonly content: string;
}

/**
 * Reader seam yielding the conversation record + its transcript. Production
 * joins the warren-0b91 `conversations` / `messages` tables; tests substitute
 * a stub so the suite stays disk- and table-free.
 */
export interface ConversationRewakeReader {
	readConversation(conversationId: string): Promise<ConversationRecord | null>;
	/** Full transcript, oldest-first (ascending `seq`). */
	readTranscript(conversationId: string): Promise<readonly TranscriptMessage[]>;
}

/**
 * Writer seam that rotates `conversations.anchoring_run_id` to the newly
 * spawned run. Kept separate from the reader so the production repo write and
 * the test assertion both have a single, narrow surface to target.
 */
export interface ConversationAnchorRotator {
	rotate(input: {
		readonly conversationId: string;
		readonly newRunId: string;
		readonly now: Date;
	}): Promise<void>;
}

/** Injectable spawn seam; defaults to the real `spawnRun`. */
export type RewakeSpawner = (input: SpawnRunInput) => Promise<SpawnRunResult>;

/**
 * Render the conversation transcript into the user-facing replay prompt for a
 * fresh pi session. Pure / deterministic so it snapshots cleanly in tests.
 *
 * The block is structured so the agent can pattern-match the prior turns and
 * pick up where the conversation left off. We replay the verbatim transcript
 * rather than a summary — token cost grows with length, accepted for v1.
 */
export function buildRewakePrompt(messages: readonly TranscriptMessage[]): string {
	const out: string[] = [];
	out.push(`<conversation_transcript count="${messages.length}">`);
	out.push(
		"<!-- Replayed prior conversation. This is a fresh session re-woken from " +
			"the persisted transcript; continue the conversation from here. -->",
	);
	for (const m of messages) {
		out.push(`<message seq="${m.seq}" role="${m.role}">`);
		out.push(m.content);
		out.push("</message>");
	}
	out.push("</conversation_transcript>");
	return out.join("\n");
}

/**
 * Input bag for `rewakeConversation`. Every reusable spawn dep is forwarded
 * into the underlying `spawnRun`; `conversationId`, `reader`, `rotator`, and
 * the optional `spawner` are unique to this entry point. The agent + Plot for
 * the new run are inherited from the prior anchoring run / conversation row,
 * never re-specified by the caller.
 */
export type RewakeConversationInput = {
	readonly conversationId: string;
	readonly reader: ConversationRewakeReader;
	readonly rotator: ConversationAnchorRotator;
	readonly spawner?: RewakeSpawner;
} & Pick<
	SpawnRunInput,
	| "repos"
	| "burrowClientPool"
	| "trigger"
	| "providerOverride"
	| "modelOverride"
	| "now"
	| "projectsConfig"
	| "projectSpawn"
	| "ref"
	| "refreshProjectFn"
	| "warrenConfigs"
	| "runBranchPrefixDefault"
	| "seedsCli"
	| "dispatcherHandle"
	| "plotAppender"
>;

export interface RewakeConversationResult {
	/** The conversation row as read before re-wake. */
	readonly conversation: ConversationRecord;
	/** The (terminal) prior anchoring run the new session was seeded from. */
	readonly priorRun: RunRow;
	/** The freshly spawned mode:"conversation" run. */
	readonly turn: SpawnRunResult;
	/** Number of transcript messages replayed into the new session. */
	readonly replayedMessageCount: number;
}

interface ResolvedRewakeTarget {
	readonly conversation: ConversationRecord;
	readonly priorRun: RunRow;
	readonly projectId: string;
	readonly plotId: string | undefined;
}

/**
 * Validate the conversation + its anchoring run, returning the resolved spawn
 * inputs. All the refusal paths (NotFound / ValidationError) live here so the
 * orchestrator stays under the cognitive-complexity ceiling.
 */
async function resolveRewakeTarget(input: RewakeConversationInput): Promise<ResolvedRewakeTarget> {
	const conversation = await input.reader.readConversation(input.conversationId);
	if (conversation === null) {
		throw new NotFoundError(`conversation not found: ${input.conversationId}`);
	}
	if (conversation.status !== "active") {
		throw new ValidationError(
			`conversation ${conversation.id} is '${conversation.status}'; only active conversations can be re-woken`,
		);
	}
	if (conversation.projectId === null) {
		throw new ValidationError(
			`conversation ${conversation.id} has no project_id (project was deleted); cannot re-wake`,
		);
	}
	if (conversation.anchoringRunId === null || conversation.anchoringRunId === "") {
		throw new ValidationError(
			`conversation ${conversation.id} has no anchoring run to re-wake from`,
		);
	}

	const priorRun = await input.repos.runs.get(conversation.anchoringRunId);
	if (priorRun === null) {
		throw new NotFoundError(
			`anchoring run not found: ${conversation.anchoringRunId} (conversation ${conversation.id})`,
		);
	}
	if (!isTerminalRunState(priorRun.state)) {
		// The anchoring run is still live — there is an active pi session to
		// talk to, so re-wake is a no-op at best and a duplicate session at
		// worst. Refuse rather than spawn.
		throw new ValidationError(
			`anchoring run ${priorRun.id} is '${priorRun.state}', not terminal; conversation ${conversation.id} is still live and needs no re-wake`,
		);
	}

	// Prefer the conversation's own Plot binding; fall back to the prior run's
	// plot_id (they agree in v1, but the conversation row is authoritative).
	const plotId = conversation.plotId ?? priorRun.plotId ?? undefined;
	return { conversation, priorRun, projectId: conversation.projectId, plotId };
}

/**
 * Forward every reusable spawn knob through verbatim. Mode is pinned to
 * `conversation`; agent + project + plot come off the resolved target. Pulled
 * out of the orchestrator so the optional-field spread doesn't inflate its
 * cognitive complexity.
 */
function buildRewakeSpawnInput(
	input: RewakeConversationInput,
	target: ResolvedRewakeTarget,
	prompt: string,
): SpawnRunInput {
	const { plotId } = target;
	return {
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		agentName: target.priorRun.agentName,
		projectId: target.projectId,
		prompt,
		mode: "conversation",
		trigger: input.trigger ?? "rewake",
		...(plotId !== undefined ? { plotId } : {}),
		...(input.providerOverride !== undefined ? { providerOverride: input.providerOverride } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.projectsConfig !== undefined ? { projectsConfig: input.projectsConfig } : {}),
		...(input.projectSpawn !== undefined ? { projectSpawn: input.projectSpawn } : {}),
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		...(input.refreshProjectFn !== undefined ? { refreshProjectFn: input.refreshProjectFn } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
		...(input.dispatcherHandle !== undefined ? { dispatcherHandle: input.dispatcherHandle } : {}),
		...(input.plotAppender !== undefined ? { plotAppender: input.plotAppender } : {}),
	};
}

export async function rewakeConversation(
	input: RewakeConversationInput,
): Promise<RewakeConversationResult> {
	const target = await resolveRewakeTarget(input);
	const { conversation, priorRun } = target;

	const messages = await input.reader.readTranscript(conversation.id);
	const body = buildRewakePrompt(messages);

	const spawner = input.spawner ?? spawnRun;
	const turn = await spawner(buildRewakeSpawnInput(input, target, body));

	// Rotate the anchoring pointer to the new run, then leave a replay trail on
	// the new run for the UI / operator. The rotate happens before the event so
	// a crash between the two leaves the conversation correctly re-anchored.
	const now = input.now?.() ?? new Date();
	await input.rotator.rotate({
		conversationId: conversation.id,
		newRunId: turn.run.id,
		now,
	});
	await appendRewakeEvent(input, turn.run.id, {
		conversationId: conversation.id,
		priorRunId: priorRun.id,
		replayedMessageCount: messages.length,
		rewokenAt: now.toISOString(),
	});

	return {
		conversation,
		priorRun,
		turn,
		replayedMessageCount: messages.length,
	};
}

async function appendRewakeEvent(
	input: Pick<RewakeConversationInput, "repos">,
	runId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await input.repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: new Date().toISOString(),
			kind: CONVERSATION_REWAKE_REPLAYED_KIND,
			stream: "system",
			payload,
		});
	} catch {
		// Logging-only trail; a failure here must not unwind a successful
		// re-wake. Mirrors recordPlotContextLoadFailure in interactive.ts.
	}
}
