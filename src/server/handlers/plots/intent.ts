/**
 * Plot intent + rename mutation handlers — `POST /plots/:id/intent` and
 * `POST /plots/:id/rename` (warren-332b / pl-369d).
 *
 * Extracted from `src/server/handlers/plots.ts`. Resolve-project +
 * envelope assembly live in `./shared.ts`.
 */

import { join } from "node:path";
import { ValidationError } from "../../../core/errors.ts";
import {
	defaultPlotIntentEditor,
	defaultPlotRenamer,
	type EditPlotIntentPatch,
} from "../../../plots/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalString, readJsonBody, requireParam } from "../index.ts";
import { buildPlotEnvelope, loadPausedRunsForPlot, resolvePlotProject } from "./shared.ts";

/**
 * `POST /plots/:id/intent` — edit a Plot's intent body (warren-896f /
 * pl-9d6a step 9).
 *
 * Handler order:
 *   (1) parse + validate the body's flat intent patch shape via
 *       `parseTopLevelIntentPatch` (unknown fields like `goals`/`nongoals`
 *       reject at the handler edge).
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project (`resolvePlotProject`; `null` /
 *       unwired resolver → 404, `hasPlot=false` → 400).
 *   (4) hand off to `deps.plotIntentEditor` (default
 *       `defaultPlotIntentEditor`) which opens a `UserPlotClient`,
 *       enforces SPEC §6's frozen-at-done rule (`PlotIntentFrozenError`
 *       → 409 / `plot_intent_frozen`), applies the patch via
 *       `PlotHandle.editIntent`, and returns the fresh envelope subset.
 *       Failure propagates synchronously — NOT fire-and-log (mx-92e6b3).
 *   (5) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new `intent_goal_preview`
 *       without the 5s TTL wait.
 *   (6) return 200 with the full `PlotEnvelope`.
 *
 * Body shape: `{ goal?, non_goals?, constraints?, success_criteria?,
 *   dispatcher_handle? }`. An empty patch (all fields omitted) is
 * accepted as a no-op — the lib's `editIntent({})` short-circuits
 * without emitting an `intent_edited` event.
 *
 * ACL note: this handler uses `UserPlotClient` exclusively (via the
 * editor seam). `AgentPlotHandle` doesn't expose `editIntent` at the
 * type level (mx-bd4d67), so the agent-actor mistake is unreachable
 * from this code path at compile time.
 */
function editPlotIntentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		const patch = parseTopLevelIntentPatch(body);
		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "edit intent on plot");

		const editor = deps.plotIntentEditor ?? defaultPlotIntentEditor;
		const result = await editor.edit({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			patch: patch ?? {},
		});

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, buildPlotEnvelope(result, project.id, paused_runs));
	};
}

/**
 * `POST /plots/:id/rename` — update a Plot's display name (warren-bed0 /
 * pl-b0c0 step 3).
 *
 * Handler order mirrors `editPlotIntentHandler`:
 *   (1) parse + validate `{name}` from the body (non-empty string after
 *       trim; unknown fields reject so typos surface). `dispatcher_handle`
 *       is accepted and threaded through but read separately.
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`.
 *   (3) resolve the owning project (`resolvePlotProject`).
 *   (4) hand off to `deps.plotRenamer` (default `defaultPlotRenamer`),
 *       which opens a `UserPlotClient`, mutates `plot.json#/name`, and
 *       appends a `note` event recording the from→to transition.
 *       Failure surfaces synchronously — NOT fire-and-log.
 *   (5) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new name without the 5s TTL wait.
 *   (6) return 200 with the full `PlotEnvelope`.
 *
 * Renames are allowed in every status. The name is pure metadata — the
 * SPEC §6 frozen-at-done rule applies only to the intent body.
 */
function renamePlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		const allowed = new Set(["name", "dispatcher_handle"]);
		for (const key of Object.keys(body)) {
			if (!allowed.has(key)) {
				throw new ValidationError(
					`field '${key}' is not recognized; expected one of name, dispatcher_handle`,
				);
			}
		}
		if (typeof body.name !== "string") {
			throw new ValidationError("field 'name' must be a string");
		}
		const trimmedName = body.name.trim();
		if (trimmedName.length === 0) {
			throw new ValidationError("field 'name' must be a non-empty string");
		}

		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "rename plot");

		const renamer = deps.plotRenamer ?? defaultPlotRenamer;
		const result = await renamer.rename({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			name: trimmedName,
		});

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, buildPlotEnvelope(result, project.id, paused_runs));
	};
}

/**
 * Parse + validate the top-level intent fields on `POST /plots/:id/intent`.
 * The wire contract here is flat (`{goal?, non_goals?, ..., dispatcher_handle?}`)
 * rather than the nested `{intent: {...}}` shape used by `POST /plots`,
 * matching the seed body verbatim. Unknown intent fields reject with 400 so
 * `goals`/`nongoals` typos surface; `dispatcher_handle` is ignored here (the
 * handler reads it separately). Identical field-typing rules as
 * `parseIntentPatch`: `goal` is a string; the three list fields are arrays
 * of non-empty strings.
 */
function parseTopLevelIntentPatch(body: Record<string, unknown>): EditPlotIntentPatch | undefined {
	const allowed = new Set(["goal", "non_goals", "constraints", "success_criteria"]);
	const ignored = new Set(["dispatcher_handle"]);
	for (const key of Object.keys(body)) {
		if (allowed.has(key) || ignored.has(key)) continue;
		throw new ValidationError(
			`field '${key}' is not recognized; expected one of goal, non_goals, constraints, success_criteria, dispatcher_handle`,
		);
	}
	const patch: {
		goal?: string;
		non_goals?: string[];
		constraints?: string[];
		success_criteria?: string[];
	} = {};
	let hasField = false;
	if (body.goal !== undefined) {
		if (typeof body.goal !== "string") {
			throw new ValidationError("field 'goal' must be a string");
		}
		patch.goal = body.goal;
		hasField = true;
	}
	for (const key of ["non_goals", "constraints", "success_criteria"] as const) {
		const v = body[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || item.length === 0)) {
			throw new ValidationError(`field '${key}' must be an array of non-empty strings`);
		}
		patch[key] = v as string[];
		hasField = true;
	}
	return hasField ? patch : undefined;
}

export { editPlotIntentHandler, renamePlotHandler };
