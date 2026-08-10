/**
 * PlanRun HTTP handlers (warren-f923 / pl-a258 step 6).
 *
 * Extracted from `src/server/handlers/index.ts` (warren-a2b4 /
 * pl-9088 step 2). As of warren-e240 (pl-882c step 8) the orchestration
 * lives in the `src/plan-runs/` domain (`createPlanRun`, `cancelPlanRun`,
 * `tailPlanRunEvents`); these handlers are a thin surface — parse the
 * request, call the domain function, render the response — matching the
 * spawnRun / addProject single-implementation pattern. The NDJSON
 * streaming plumbing (`bridgeAbort`, `asNdjsonStream`, `eventToNdjson`)
 * is re-imported from `./runs.ts` so the plan-run stream handler stays
 * byte-identical to the pre-split shape.
 */

import { ValidationError } from "../../core/errors.ts";
import { cancelPlanRun, createPlanRun, tailPlanRunEvents } from "../../plan-runs/index.ts";
import { jsonResponse, ndjsonResponse } from "../response.ts";
import { reserveEventStreamSlot } from "../stream-limits.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalPositiveNumber } from "./body-fields.ts";
import {
	optionalString,
	parseBoolean,
	readJsonBody,
	requireParam,
	requireString,
} from "./index.ts";
import { projectPlanRun, projectPlanRunChild } from "./plan-runs-projection.ts";
import {
	asNdjsonStream,
	bridgeAbort,
	cancelRunWiring,
	eventToNdjson,
	projectRun,
} from "./runs/index.ts";

/* ----------------------------------------------------------------------- */
/* Plan runs (warren-f923 / pl-a258 step 6)                                 */
/* ----------------------------------------------------------------------- */

const PLAN_RUN_STATE_FILTER_VALUES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
type PlanRunStateFilter = (typeof PLAN_RUN_STATE_FILTER_VALUES)[number];

function parsePlanRunStateFilter(raw: string | null): PlanRunStateFilter | undefined {
	if (raw === null) return undefined;
	if (!(PLAN_RUN_STATE_FILTER_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`?state must be one of ${PLAN_RUN_STATE_FILTER_VALUES.join(", ")}; got '${raw}'`,
		);
	}
	return raw as PlanRunStateFilter;
}

/**
 * `POST /plan-runs` — kick off a serial plan execution against a seeds plan.
 * Body parsing only; the orchestration (project gate, plan walk, agent
 * resolution, transactional persist) is `createPlanRun` in the domain.
 * Returns 201 with {planRun, children}; the coordinator picks the row up on
 * its next tick.
 */
export function createPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const promptTemplate = optionalString(body, "promptTemplate");
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		// warren-a63d: per-child spend cap; each child dispatch carries it as
		// maxCostUsdOverride. Same boundary validation as POST /runs.
		const maxCostUsd = optionalPositiveNumber(body, "maxCostUsd");

		const result = await createPlanRun({
			projectId: requireString(body, "project"),
			planId: requireString(body, "planId"),
			agentName: requireString(body, "agent"),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			repos: deps.repos,
			seedsCli: deps.seedsCli,
			projectsConfig: deps.projectsConfig,
			...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
			...(deps.autoOpenPr?.gitToken !== undefined ? { gitToken: deps.autoOpenPr.gitToken } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.refreshProjectFn !== undefined ? { refreshProjectFn: deps.refreshProjectFn } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});

		return jsonResponse(201, {
			planRun: result.planRun,
			children: result.children,
		});
	};
}

/**
 * `GET /plan-runs?project=&state=` — list plan-runs, optionally filtered.
 * Options-bag shape mirrors `listRunsHandler` (mx-f1a881) so a UI rendering
 * either endpoint can share its query plumbing.
 */
export function listPlanRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = ctx.url.searchParams.get("project");
		const state = parsePlanRunStateFilter(ctx.url.searchParams.get("state"));
		if (projectId !== null) {
			const rows = await deps.repos.planRuns.listByProjectAndState(
				projectId,
				state !== undefined ? state : undefined,
			);
			return jsonResponse(200, {
				planRuns: rows.map((row) => projectPlanRun(row, ctx.actor)),
			});
		}
		// No project filter — return active PlanRuns when no state requested,
		// or the operator's chosen state across every project.
		if (state !== undefined) {
			// listByProjectAndState requires a project; for a state-only view
			// we walk projects sequentially. Volume is tiny relative to runs
			// (one plan-run per dispatched plan, not per child).
			const projects = await deps.repos.projects.listAll();
			const all = (
				await Promise.all(
					projects.map((p) => deps.repos.planRuns.listByProjectAndState(p.id, state)),
				)
			).flat();
			return jsonResponse(200, {
				planRuns: all.map((row) => projectPlanRun(row, ctx.actor)),
			});
		}
		const active = await deps.repos.planRuns.listActive();
		return jsonResponse(200, {
			planRuns: active.map((row) => projectPlanRun(row, ctx.actor)),
		});
	};
}

/**
 * `GET /plan-runs/:id` — full detail page payload: row + children + the
 * fanned-out `runs[]` from runs.listByIds(child.runId for each non-null)
 * so the UI's detail page renders in one round-trip.
 *
 * `runs[]` goes through the SAME `projectRun` the `/runs` routes use
 * (warren-c405): this route is `readPublic`, so serving the rows raw handed
 * a spectator every field `REDACTED_RUN_FIELDS` withholds elsewhere.
 * `planRun` and `children` go through `projectPlanRun` / `projectPlanRunChild`
 * (warren-8793): this pair was the last `readPublic` body served with no
 * field allowlist, leaking `promptTemplate`, the dispatch overrides,
 * `dispatcherHandle`, and raw internal error strings on `failureReason`.
 */
export function getPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const children = await deps.repos.planRuns.listChildren(id);
		const runIds = children.map((c) => c.runId).filter((v): v is string => v !== null);
		const runs = await deps.repos.runs.listByIds(runIds);
		return jsonResponse(200, {
			planRun: projectPlanRun(planRun, ctx.actor),
			children: children.map((child) => projectPlanRunChild(child, ctx.actor)),
			runs: runs.map((run) => projectRun(run, ctx.actor)),
		});
	};
}

/**
 * `POST /plan-runs/:id/cancel` — flip the plan-run to `cancelled` and, if
 * a child run is in-flight (dispatched / running / pr_open), forward a
 * cancel to that child via the existing `cancelRun` seam. The orchestration
 * is `cancelPlanRun` in the domain; this handler only binds the deps.
 *
 * Idempotent against an already-terminal plan-run: returns the current row
 * without firing a second cancel.
 */
export function cancelPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const result = await cancelPlanRun({
			planRunId: requireParam(ctx, "id"),
			repos: deps.repos,
			broker: deps.broker,
			...cancelRunWiring(deps), // warren-b223: provider + burrow-bound inline reap
			...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
			logger: deps.logger,
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, result);
	};
}

/**
 * `GET /plan-runs/:id/events` — NDJSON tail of the union of every child
 * run's events. Read-only: snapshots `events.listByRunIds(...)` first,
 * then subscribes to the broker for each child run. Live arrivals after
 * the snapshot are deduped by (runId, burrowEventSeq). The generator is
 * `tailPlanRunEvents` in the domain.
 *
 * `?follow=1` keeps the stream open until the client disconnects or the
 * plan-run reaches a terminal state. Default (no follow) returns the
 * snapshot then closes.
 */
export function streamPlanRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const ctrl = bridgeAbort(ctx.request.signal);
		// Same concurrency admission as the single-run twin (warren-25f6): a
		// plan-run stream fans in every child, so it is the more expensive of
		// the two to leave uncapped.
		const slot = reserveEventStreamSlot({
			limiter: deps.streamLimiter,
			ctx,
			ctrl,
			route: "GET /plan-runs/:id/events",
		});

		const source = tailPlanRunEvents({
			planRunId: planRun.id,
			repos: deps.repos,
			broker: deps.broker,
			follow,
			signal: ctrl.signal,
		});
		return ndjsonResponse(
			asNdjsonStream(
				source,
				(row) => eventToNdjson(row, ctx.actor),
				ctrl,
				() => slot.release(),
			),
		);
	};
}
