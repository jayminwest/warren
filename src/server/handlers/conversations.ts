/**
 * Conversation HTTP handlers (LEVERET.md §0.11 / §0.9 / §0.2,
 * build-phase 4 / warren-af15).
 *
 * A conversation is a long-lived leveret chat that shapes a Plot's intent
 * (see `src/registry/builtins/leveret.ts`). Each conversation owns exactly
 * one *anchoring* `mode:'conversation'` run at a time (it rotates on
 * re-wake, warren-6ccf). Those anchoring runs are deliberately HIDDEN from
 * the Runs API (`src/db/repos/runs.ts` excludes `mode:'conversation'` from
 * the list/aggregate paths) — operators see conversations here, not a pile
 * of never-terminating runs on the Runs page.
 *
 * Surface:
 *   - `POST   /conversations`          create + dispatch the anchoring run.
 *   - `GET    /conversations`          list (optional ?project / ?plot / ?status).
 *   - `GET    /conversations/:id`      conversation + full transcript.
 *   - `POST   /conversations/:id/messages` operator turn (steering channel).
 *
 * Create binds to a Plot one of two ways (operator choice, §0.2): pass
 * `plot_id` to ATTACH to an existing Plot, or omit it to AUTO-CREATE a
 * fresh Plot (same `plotCreator` seam `POST /plots` uses). N conversations
 * bind to one Plot (N:1).
 *
 * post-message delivers the operator turn over the repointed steering
 * channel (`steerRun` → burrow inbox) so the live pi session picks it up on
 * its next turn, and persists it to the `messages` transcript so re-wake
 * (warren-6ccf) can replay it into a fresh session.
 */

import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { assertRunTransition } from "../../db/repos/runs.ts";
import type { ConversationRow, ConversationState } from "../../db/schema.ts";
import { ProjectLacksPlotError } from "../../plan-runs/errors.ts";
import { defaultPlotCreator, defaultPlotSyncer } from "../../plots/index.ts";
import { resolveDispatcherHandle, spawnRun, steerRun } from "../../runs/index.ts";
import { loadWarrenConfig } from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import {
	assertPlotIdDispatchable,
	defaultSpawn,
	optionalString,
	readJsonBody,
	requireParam,
	requireString,
} from "./index.ts";
import { plotProjectionForProject, resolvePlotProject } from "./plots/shared.ts";

/** The conversational overseer agent (src/registry/builtins/leveret.ts). */
const LEVERET_AGENT = "leveret";

/**
 * System event emitted on the anchoring run when the operator sends a
 * conversation to the planner (warren-756d). Marks the run terminal alongside
 * the conversation `active → closed` flip.
 */
export const CONVERSATION_SENT_OFF_KIND = "conversation.sent_off";

/**
 * Seed prompt for a fresh conversation when the operator dispatches without
 * an opening message. Leveret reads it as the user's first turn.
 */
const DEFAULT_OPENING_PROMPT =
	"Let's shape this Plot's intent. Ask me what we're trying to build, then drive toward goal, non-goals, constraints, and success criteria.";

function parseStatusFilter(raw: string | null): ConversationState | undefined {
	if (raw === null || raw === "") return undefined;
	if (raw !== "active" && raw !== "closed") {
		throw new ValidationError(`?status must be 'active' or 'closed'; got '${raw}'`);
	}
	return raw;
}

/**
 * Resolve the Plot the conversation binds to. With `plot_id` set, ATTACH to
 * the existing Plot (format + existence validated like the dispatch edge).
 * Without it, AUTO-CREATE a fresh Plot via the same seam `POST /plots` uses.
 * Factored out so `createConversationHandler` stays under the complexity
 * ceiling.
 */
async function resolveConversationPlot(
	deps: ServerDeps,
	body: Record<string, unknown>,
	project: import("../../db/schema.ts").ProjectRow,
	handle: string,
): Promise<string> {
	const attachPlotId = optionalString(body, "plot_id");
	if (attachPlotId !== undefined && attachPlotId !== "") {
		await assertPlotIdDispatchable({ plotId: attachPlotId, plotResolver: deps.plotResolver });
		return attachPlotId;
	}
	if (!project.hasPlot) {
		throw new ProjectLacksPlotError(
			`project ${project.id} has no .plot/ directory; cannot auto-create a Plot for a conversation`,
			{
				recoveryHint:
					"run `plot init` in the project clone and refresh the project, or pass an existing plot_id to attach",
			},
		);
	}
	const name = optionalString(body, "title") ?? "Conversation";
	const creator = deps.plotCreator ?? defaultPlotCreator;
	const created = await creator.create({
		plotDir: join(project.localPath, ".plot"),
		handle,
		name,
		projection: plotProjectionForProject(deps, project.id),
	});
	deps.plotAggregator?.invalidate(project.id);
	return created.id;
}

export function createConversationHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project_id");
		const agentName = optionalString(body, "agent") ?? LEVERET_AGENT;
		const dispatcherHandle = optionalString(body, "dispatcher_handle");
		const handle = resolveDispatcherHandle(dispatcherHandle);
		const opening = optionalString(body, "message") ?? DEFAULT_OPENING_PROMPT;
		const title = optionalString(body, "title");

		const project = await deps.repos.projects.require(projectId);
		const plotId = await resolveConversationPlot(deps, body, project, handle);

		const result = await spawnRun({
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName,
			projectId,
			prompt: opening,
			mode: "conversation",
			trigger: "conversation",
			plotId,
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			dispatcherHandle,
			warrenConfigs: deps.warrenConfigs,
			runBranchPrefixDefault: deps.runBranchPrefixDefault,
			seedsCli: deps.seedsCli,
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});

		const conversation = await deps.repos.conversations.create({
			projectId,
			plotId,
			anchoringRunId: result.run.id,
			...(title !== undefined ? { title } : {}),
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// Persist the opening operator turn so re-wake can replay it.
		await deps.repos.messages.append({
			conversationId: conversation.id,
			role: "user",
			content: opening,
			runId: result.run.id,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);

		return jsonResponse(201, {
			conversation,
			run: { id: result.run.id, mode: result.run.mode },
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

export function listConversationsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const plot = ctx.url.searchParams.get("plot");
		if (project !== null && plot !== null) {
			throw new ValidationError("filter by either ?project=... or ?plot=..., not both");
		}
		const status = parseStatusFilter(ctx.url.searchParams.get("status"));
		let rows: ConversationRow[];
		if (project !== null) {
			rows = await deps.repos.conversations.listByProject(project, status);
		} else if (plot !== null) {
			rows = await deps.repos.conversations.listByPlotId(plot);
		} else {
			rows = await deps.repos.conversations.listAll(status);
		}
		return jsonResponse(200, { conversations: rows });
	};
}

export function getConversationHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const conversation = await deps.repos.conversations.require(id);
		const messages = await deps.repos.messages.listByConversation(id);
		return jsonResponse(200, { conversation, messages });
	};
}

/**
 * `POST /conversations/:id/messages` — deliver an operator turn.
 *
 * Persists the turn to the transcript, then forwards it over the steering
 * channel to the anchoring run's burrow so the live pi session reads it on
 * its next turn. 202 Accepted: the leveret reply lands asynchronously on the
 * stream (and is persisted by the conversation bridge, warren-ce65).
 *
 * Errors: 400 if the conversation is closed or has no live anchoring run;
 * 404 if the conversation is unknown. A terminal anchoring run surfaces the
 * `steerRun` validation error (re-wake is warren-6ccf, out of scope here).
 */
export function postConversationMessageHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const message = requireString(body, "message");
		const fromActor = optionalString(body, "dispatcher_handle");

		const conversation = await deps.repos.conversations.require(id);
		if (conversation.status === "closed") {
			throw new ValidationError(`conversation ${id} is closed; cannot post a message`, {
				recoveryHint: "start a new conversation",
			});
		}
		if (conversation.anchoringRunId === null) {
			throw new ValidationError(`conversation ${id} has no anchoring run to deliver to`, {
				recoveryHint: "re-wake the conversation before posting (warren-6ccf)",
			});
		}

		const now = deps.now?.() ?? new Date();
		const persisted = await deps.repos.messages.append({
			conversationId: id,
			role: "user",
			content: message,
			runId: conversation.anchoringRunId,
			now,
		});
		await deps.repos.conversations.touch(id, now);

		const result = await steerRun({
			runId: conversation.anchoringRunId,
			body: message,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(fromActor !== undefined ? { fromActor } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});

		return jsonResponse(202, {
			conversationId: id,
			message: { id: persisted.id, seq: persisted.seq, role: persisted.role },
			steerMessageId: result.message.id,
		});
	};
}

/**
 * Resolve the per-project `plotSync` config for the send-off PR, falling back
 * to defaults when no `.warren/config.yaml` is present. Mirrors the resolution
 * in `src/server/handlers/plots/sync.ts` so the two PR-opening paths behave
 * identically.
 */
async function resolvePlotSyncConfig(
	deps: ServerDeps,
	project: { id: string; localPath: string },
): Promise<import("../../warren-config/index.ts").PlotSyncConfig | undefined> {
	try {
		const config =
			deps.warrenConfigs !== undefined
				? await deps.warrenConfigs.get(project.id, project.localPath)
				: await loadWarrenConfig({ projectPath: project.localPath });
		return config.defaults?.plotSync;
	} catch {
		return undefined;
	}
}

/**
 * Finalize the anchoring run alongside the conversation `active → closed`
 * flip. Defensive: a run that already went terminal (idle-finalize, crash
 * recovery) is left as-is — the conversation close is the source of truth.
 */
async function finalizeAnchoringRun(
	deps: ServerDeps,
	conversation: ConversationRow,
	now: Date,
): Promise<void> {
	if (conversation.anchoringRunId === null) return;
	const run = await deps.repos.runs.get(conversation.anchoringRunId);
	if (run === null || run.state !== "running") return;
	assertRunTransition(run.state, "succeeded");
	await deps.repos.runs.finalize(run.id, "succeeded", now);
	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	await deps.repos.events.append({
		runId: run.id,
		burrowEventSeq: seq,
		ts: now.toISOString(),
		kind: CONVERSATION_SENT_OFF_KIND,
		stream: "system",
		payload: { conversationId: conversation.id, finalizedAt: now.toISOString() },
	});
}

/**
 * `POST /conversations/:id/send-off` — "Send to planner" (LEVERET.md §0.0.B /
 * §0.7 / warren-756d).
 *
 * Opens a plotSync PR whose ONLY change is the plot-state update (safe by
 * construction — leveret ships no edit/write tool), CLOSES the conversation
 * (anchoring run finalizes, the Plot persists), and PERSISTS the submitted PR
 * ref + plot_id + planner agent on the conversation row so the merge poller
 * (warren-b872) can auto-dispatch the planner run keyed on `plot_id` once the
 * PR merges. Re-plan after send-off is a NEW conversation attached to the same
 * Plot (§0.0.C).
 *
 * Errors: 400 if the conversation is already closed or has no Plot bound (no
 * intent to submit), or if there is no dirty `.plot/` change to ship; 404 if
 * the conversation (or its Plot's project) is unknown.
 */
export function sendOffConversationHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const plannerAgent = optionalString(body, "planner_agent") ?? null;

		const conversation = await deps.repos.conversations.require(id);
		if (conversation.status === "closed") {
			throw new ValidationError(`conversation ${id} is already closed; cannot send to planner`, {
				recoveryHint: "start a new conversation to re-plan against the same Plot",
			});
		}
		if (conversation.plotId === null || conversation.plotId === "") {
			throw new ValidationError(`conversation ${id} has no Plot bound; nothing to send`, {
				recoveryHint: "shape the Plot's intent before sending to the planner",
			});
		}

		const project = await resolvePlotProject(deps, conversation.plotId, "send plot to planner");
		const syncer = deps.plotSyncer ?? defaultPlotSyncer;
		const result = await syncer.sync({
			projectPath: project.localPath,
			gitUrl: project.gitUrl,
			defaultBranch: project.defaultBranch,
			token: deps.autoOpenPr?.token ?? "",
			handle: "warren",
			plotSyncConfig: await resolvePlotSyncConfig(deps, project),
			spawn: deps.spawn ?? defaultSpawn,
			gitBinary: deps.projectsConfig.gitBinary,
		});

		if (result.kind === "no_op") {
			throw new ValidationError(
				`conversation ${id} has no plot-state changes to submit to the planner`,
				{ recoveryHint: "shape the Plot's intent before sending to the planner" },
			);
		}

		const now = deps.now?.() ?? new Date();
		await finalizeAnchoringRun(deps, conversation, now);
		const closed = await deps.repos.conversations.recordSubmission(
			id,
			{
				prUrl: result.prUrl,
				...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
				plannerAgent,
			},
			now,
		);

		return jsonResponse(200, {
			conversation: closed,
			plot_id: conversation.plotId,
			pr: { url: result.prUrl, number: result.prNumber ?? null, branch: result.branch },
			planner_agent: plannerAgent,
		});
	};
}
