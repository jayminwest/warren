/**
 * Workbench Plot HTTP handlers (brainstorm, formalize, answer).
 *
 * Extracted from `src/server/handlers/plots.ts` (warren-3f46 / pl-3255 step 1).
 */

import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../../core/errors.ts";
import { ProjectLacksPlotError } from "../../../plan-runs/errors.ts";
import {
	createDefaultPlotFormalizer,
	defaultPlotCreator,
	defaultPlotQuestionAnswerer,
	type PlotSummary,
} from "../../../plots/index.ts";
import {
	appendUserMessage,
	buildInteractivePrompt,
	defaultPlotContextReader,
	resolveDispatcherHandle,
	spawnRun,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	defaultSpawn,
	optionalString,
	readJsonBody,
	requireParam,
	requireString,
} from "../index.ts";
import { triggerBackgroundSync } from "./sync.ts";

/**
 * `POST /brainstorm` — one-shot brainstorm dispatcher (warren-d22e /
 * pl-0344 step 8).
 */
function createBrainstormHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project_id");
		const prompt = requireString(body, "prompt");
		const rawName = optionalString(body, "name");
		if (rawName !== undefined && rawName.trim().length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string when provided");
		}
		const name = rawName !== undefined ? rawName : "Untitled brainstorm";
		const dispatcherHandle = optionalString(body, "dispatcher_handle");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const ref = optionalString(body, "ref");
		const agentName = optionalString(body, "agent") ?? "brainstorm";

		const project = await deps.repos.projects.require(projectId);
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot start a brainstorm`,
				{
					recoveryHint:
						"run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		const handle = resolveDispatcherHandle(dispatcherHandle);

		const creator = deps.plotCreator ?? defaultPlotCreator;
		const created = await creator.create({
			plotDir: join(project.localPath, ".plot"),
			handle,
			name,
		});
		deps.plotAggregator?.invalidate(project.id);

		const dispatchedPrompt = await buildPromptForBrainstorm(
			project.localPath,
			created.id,
			handle,
			prompt,
		);

		const spawned = await spawnBrainstormRun(
			deps,
			project,
			created.id,
			dispatchedPrompt,
			agentName,
			handle,
			ref,
			providerOverride,
			modelOverride,
		);

		await appendUserMessage({
			repos: deps.repos,
			runId: spawned.run.id,
			message: prompt,
			handle,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		deps.bridges.start(spawned.run.id, spawned.burrowRun.id, spawned.burrow.id);

		const summary: PlotSummary = {
			id: created.id,
			name: created.name,
			status: created.status,
			intent_goal_preview: created.intent_goal_preview,
			attachments_count: created.attachments_count,
			last_event_ts: created.last_event_ts,
			last_event_actor: created.last_event_actor,
			project_id: project.id,
		};
		return jsonResponse(201, {
			plot: summary,
			run: spawned.run,
			burrow: {
				id: spawned.burrow.id,
				workspacePath: spawned.burrow.workspacePath,
			},
		});
	};
}

async function buildPromptForBrainstorm(
	projectPath: string,
	plotId: string,
	handle: string,
	prompt: string,
): Promise<string> {
	let context = null;
	try {
		context = await defaultPlotContextReader.read({
			plotDir: join(projectPath, ".plot"),
			plotId,
			historyTail: 0,
			handle,
		});
	} catch {
		// Best-effort
	}
	return buildInteractivePrompt(context, prompt);
}

async function spawnBrainstormRun(
	deps: ServerDeps,
	project: { id: string },
	createdPlotId: string,
	dispatchedPrompt: string,
	agentName: string,
	handle: string,
	ref: string | undefined,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
) {
	return spawnRun({
		repos: deps.repos,
		burrowClientPool: deps.burrowClientPool,
		agentName,
		projectId: project.id,
		prompt: dispatchedPrompt,
		mode: "interactive",
		plotId: createdPlotId,
		dispatcherHandle: handle,
		trigger: "brainstorm",
		projectsConfig: deps.projectsConfig,
		projectSpawn: deps.spawn ?? defaultSpawn,
		...(ref !== undefined ? { ref } : {}),
		...(providerOverride !== undefined ? { providerOverride } : {}),
		...(modelOverride !== undefined ? { modelOverride } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
		...(deps.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
			: {}),
		...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
	});
}

/**
 * `POST /plots/:id/formalize` — brainstorm-summarize endpoint
 * (warren-d22e / pl-0344 step 8).
 */
function formalizePlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");

		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot formalize plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		const formalizer = deps.plotFormalizer ?? createDefaultPlotFormalizer({ repos: deps.repos });
		const result = await formalizer.formalize({ plotId });

		triggerBackgroundSync(deps, project, plotId);

		return jsonResponse(200, result);
	};
}

/**
 * `POST /plots/:id/questions/:event_id/answer` — answer a `question_posed`
 * event with a `question_answered` event (warren-e1ac / pl-9d6a step 12).
 */
function answerPlotQuestionHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const eventId = requireParam(ctx, "event_id");
		if (eventId.length === 0) {
			throw new ValidationError("path param ':event_id' must be a non-empty string");
		}

		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		const rawAnswer = body.answer;
		if (typeof rawAnswer !== "string" || rawAnswer.length === 0) {
			throw new ValidationError("field 'answer' must be a non-empty string");
		}

		const handle = resolveDispatcherHandle(dispatcherHandle);

		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot answer question on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		const answerer = deps.plotQuestionAnswerer ?? defaultPlotQuestionAnswerer;
		const result = await answerer.answer({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			eventId,
			answer: rawAnswer,
		});

		deps.plotAggregator?.invalidate(project.id);

		return jsonResponse(200, { event: result.event });
	};
}

export { answerPlotQuestionHandler, createBrainstormHandler, formalizePlotHandler };
