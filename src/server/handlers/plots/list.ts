/**
 * List/create Plot HTTP handlers.
 *
 * Extracted from `src/server/handlers/plots.ts` (warren-3f46 / pl-3255 step 1).
 */

import { join } from "node:path";
import { PLOT_STATUSES, type PlotStatus } from "@os-eco/plot-cli";
import { ValidationError } from "../../../core/errors.ts";
import { ProjectLacksPlotError } from "../../../plan-runs/errors.ts";
import {
	defaultPlotCreator,
	EMPTY_PLOT_SUMMARIES,
	type PlotNeedsAttentionSummary,
	type PlotSummary,
} from "../../../plots/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalString, readJsonBody, requireString } from "../index.ts";
import { plotProjectionForProject } from "./shared.ts";

/**
 * `GET /plots?status=` — list Plot summaries aggregated across every
 * `hasPlot=true` project (warren-c167 / pl-9d6a step 2).
 */
function listPlotsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const rawStatus = ctx.url.searchParams.get("status");
		const rawFilter = ctx.url.searchParams.get("filter");
		const status = validateStatus(rawStatus);

		if (rawFilter !== null && rawFilter !== "") {
			return handleNeedsAttentionFilter(status, rawFilter, deps);
		}
		if (deps.plotAggregator === undefined) {
			return jsonResponse(200, { plots: EMPTY_PLOT_SUMMARIES });
		}
		const plots = await deps.plotAggregator.listSummaries(
			status !== undefined ? { status } : undefined,
		);
		return jsonResponse(200, { plots });
	};
}

function validateStatus(rawStatus: string | null): PlotStatus | undefined {
	if (rawStatus !== null && rawStatus !== "") {
		if (!(PLOT_STATUSES as readonly string[]).includes(rawStatus)) {
			throw new ValidationError(
				`unknown status '${rawStatus}'; expected one of ${PLOT_STATUSES.join(", ")}`,
			);
		}
		return rawStatus as PlotStatus;
	}
	return undefined;
}

async function handleNeedsAttentionFilter(
	status: PlotStatus | undefined,
	rawFilter: string,
	deps: ServerDeps,
) {
	if (rawFilter !== "needs_attention") {
		throw new ValidationError(`unknown filter '${rawFilter}'; expected one of needs_attention`);
	}
	if (deps.plotAggregator === undefined) {
		return jsonResponse(200, { plots: [] as readonly PlotNeedsAttentionSummary[] });
	}
	const rows = await deps.plotAggregator.listNeedsAttention();
	const filtered = status !== undefined ? rows.filter((r) => r.status === status) : rows;
	return jsonResponse(200, { plots: filtered });
}

/**
 * `GET /plots/needs-attention/count` — sidebar-badge counter for the
 * deployment-wide "Needs you" view (warren-d693 / pl-0344 step 9).
 */
function needsAttentionCountHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		if (deps.plotAggregator === undefined) {
			return jsonResponse(200, { count: 0 });
		}
		const count = await deps.plotAggregator.countNeedsAttention();
		return jsonResponse(200, { count });
	};
}

/**
 * `POST /plots` — create a fresh Plot in the named project's `.plot/`
 * directory (warren-194e / pl-9d6a step 3).
 */
function createPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project_id");
		const rawName = optionalString(body, "name");
		if (rawName !== undefined && rawName.trim().length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string when provided");
		}
		const name = rawName !== undefined ? rawName : "Untitled Plot";
		const dispatcherHandle = optionalString(body, "dispatcher_handle");
		const intent = parseIntentPatch(body.intent);

		const project = await deps.repos.projects.require(projectId);

		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot create a Plot`,
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
			...(intent !== undefined ? { intent } : {}),
			projection: plotProjectionForProject(deps, project.id),
		});

		deps.plotAggregator?.invalidate(project.id);

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
		return jsonResponse(201, summary);
	};
}

/**
 * Parse + validate the optional `intent` body field on `POST /plots`.
 */
function parseIntentPatch(
	raw: unknown,
): import("../../../plots/index.ts").CreatePlotIntentPatch | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ValidationError("field 'intent' must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	validateIntentKeys(obj);

	const patch: {
		goal?: string;
		non_goals?: string[];
		constraints?: string[];
		success_criteria?: string[];
	} = {};
	if (obj.goal !== undefined) {
		if (typeof obj.goal !== "string") {
			throw new ValidationError("field 'intent.goal' must be a string");
		}
		patch.goal = obj.goal;
	}
	for (const key of ["non_goals", "constraints", "success_criteria"] as const) {
		const v = obj[key];
		if (v === undefined) continue;
		validateListField(key, v);
		patch[key] = v as string[];
	}
	return patch;
}

function validateIntentKeys(obj: Record<string, unknown>): void {
	const allowed = new Set(["goal", "non_goals", "constraints", "success_criteria"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new ValidationError(
				`field 'intent.${key}' is not recognized; expected one of goal, non_goals, constraints, success_criteria`,
			);
		}
	}
}

function validateListField(key: string, v: unknown): void {
	if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new ValidationError(`field 'intent.${key}' must be an array of non-empty strings`);
	}
}

export { createPlotHandler, listPlotsHandler, needsAttentionCountHandler };
