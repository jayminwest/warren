/**
 * Workbench Plot HTTP handlers (formalize, answer).
 *
 * Extracted from `src/server/handlers/plots.ts` (warren-3f46 / pl-3255 step 1).
 * The brainstorm dispatcher that used to live here was retired with the
 * mode=interactive path (warren-d622 / LEVERET.md §0.8); intent shaping now
 * rides conversations (`src/server/handlers/conversations.ts`).
 */

import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../../core/errors.ts";
import { ProjectLacksPlotError } from "../../../plan-runs/errors.ts";
import { createDefaultPlotFormalizer, defaultPlotQuestionAnswerer } from "../../../plots/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalString, readJsonBody, requireParam } from "../index.ts";
import { triggerBackgroundSync } from "./sync.ts";

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

export { answerPlotQuestionHandler, formalizePlotHandler };
