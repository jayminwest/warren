/**
 * Plot status-transition handler — `POST /plots/:id/status`
 * (warren-332b / pl-369d).
 *
 * Extracted from `src/server/handlers/plots.ts`. Resolve-project plumbing
 * lives in `./shared.ts`; background sync is triggered via `./sync.ts`.
 */

import { join } from "node:path";
import { PLOT_STATUSES, type PlotStatus } from "@os-eco/plot-cli";
import { ValidationError } from "../../../core/errors.ts";
import { defaultPlotStatusChanger, type PlotSummary } from "../../../plots/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalString, readJsonBody, requireParam } from "../index.ts";
import { plotProjectionForProject, resolvePlotProject } from "./shared.ts";
import { triggerBackgroundSync } from "./sync.ts";

/**
 * `POST /plots/:id/status` — transition a Plot's status (warren-e868 /
 * pl-9d6a step 10).
 *
 * Handler order:
 *   (1) parse + validate the body's `next` field against
 *       `PLOT_STATUSES` (typo guard at the handler edge — same
 *       whitelist `GET /plots?status=` uses).
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project (`resolvePlotProject`; `null` /
 *       unwired resolver → 404, `hasPlot=false` → 400).
 *   (4) hand off to `deps.plotStatusChanger` (default
 *       `defaultPlotStatusChanger`) which opens a `UserPlotClient`,
 *       runs the SPEC §6.5 transition matrix
 *       (`assertStatusTransitionAllowed`) against the on-disk current
 *       status, calls `setStatus(next)`, and snapshots the fresh
 *       summary + `status_changed` event. Failure propagates
 *       synchronously — NOT fire-and-log (mx-92e6b3).
 *   (5) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new status (and the
 *       refreshed `last_event_ts`/`last_event_actor`) without the 5s
 *       TTL wait.
 *   (6) return 200 with `{ summary: PlotSummary, event: PlotEvent }`
 *       — the UI splices `event` into the optimistic activity feed and
 *       reconciles the summary row against the next list response.
 *
 * Body shape: `{ next: 'drafting'|'ready'|'active'|'done'|'archived',
 *   dispatcher_handle? }`. Unknown body fields are ignored
 *   (forward-compatible with later additions like `reason`).
 *
 * ACL note: this handler uses `UserPlotClient` exclusively (via the
 * status-changer seam). `AgentPlotHandle` doesn't expose `setStatus`
 * at the type level (mx-bd4d67), so the agent-actor mistake is
 * unreachable from this code path at compile time.
 */
function changePlotStatusHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		const rawNext = body.next;
		if (typeof rawNext !== "string") {
			throw new ValidationError("field 'next' must be a string");
		}
		if (!(PLOT_STATUSES as readonly string[]).includes(rawNext)) {
			throw new ValidationError(
				`unknown status '${rawNext}'; expected one of ${PLOT_STATUSES.join(", ")}`,
			);
		}
		const next = rawNext as PlotStatus;

		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "change status on plot");

		// The changer reads the current status from disk and re-runs
		// `assertStatusTransitionAllowed` before calling `setStatus`; warren
		// never constructs an invalid transition (defense in depth on top of
		// the lib's own guard).
		const changer = deps.plotStatusChanger ?? defaultPlotStatusChanger;
		const result = await changer.change({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			next,
			projection: plotProjectionForProject(deps, project.id),
		});

		deps.plotAggregator?.invalidate(project.id);

		triggerBackgroundSync(deps, project, plotId);

		const summary: PlotSummary = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent_goal_preview: result.intent_goal_preview,
			attachments_count: result.attachments_count,
			last_event_ts: result.last_event_ts,
			last_event_actor: result.last_event_actor,
			project_id: project.id,
		};
		return jsonResponse(200, { summary, event: result.event });
	};
}

export { changePlotStatusHandler };
