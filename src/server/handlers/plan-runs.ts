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
import {
	isTerminalPlanRunState,
	PLAN_RUN_STATE_FILTERS,
	type PlanRunStateFilter,
} from "../../core/wire.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import {
	buildDefaultPlanRunEmit,
	cancelPlanRun,
	createPlanRun,
	resumePlanRun,
	tailPlanRunEvents,
} from "../../plan-runs/index.ts";
import { jsonResponse, ndjsonResponse } from "../response.ts";
import { reserveEventStreamSlot } from "../stream-limits.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalPositiveNumber, optionalStringArray } from "./body-fields.ts";
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

function parsePlanRunStateFilter(raw: string | null): PlanRunStateFilter | undefined {
	if (raw === null) return undefined;
	if (!(PLAN_RUN_STATE_FILTERS as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`?state must be one of ${PLAN_RUN_STATE_FILTERS.join(", ")}; got '${raw}'`,
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
		// warren-de42: planId | issues are mutually exclusive and exactly one
		// is required — the domain (createPlanRun) owns that assertion.
		const planId = optionalString(body, "planId");
		const issues = optionalStringArray(body, "issues");
		// warren-a63d: per-child spend cap; each child dispatch carries it as
		// maxCostUsdOverride. Same boundary validation as POST /runs.
		const maxCostUsd = optionalPositiveNumber(body, "maxCostUsd");

		const projectId = requireString(body, "project");
		// warren-6c4c: mint the pre-dispatch refresh-fetch credential per-spawn
		// through the boot forge (forge-contract.md §4); no config object
		// holds a token.
		const project = await deps.repos.projects.require(projectId);
		const gitSecret = await mintGitCredential(deps.forge, project.gitUrl);
		const result = await createPlanRun({
			projectId,
			...(planId !== undefined ? { planId } : {}),
			...(issues !== undefined ? { issues } : {}),
			agentName: requireString(body, "agent"),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			repos: deps.repos,
			issueTracker: deps.issueTracker,
			projectsConfig: deps.projectsConfig,
			...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
			...(gitSecret !== undefined ? { gitCredential: gitSecret } : {}),
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
				state !== undefined && state !== "active" ? state : undefined,
			);
			const scoped =
				state === "active" ? rows.filter((row) => !isTerminalPlanRunState(row.state)) : rows;
			return jsonResponse(200, {
				planRuns: scoped.map((row) => projectPlanRun(row, ctx.actor)),
			});
		}
		if (state === "active") {
			const active = await deps.repos.planRuns.listActive();
			return jsonResponse(200, {
				planRuns: active.map((row) => projectPlanRun(row, ctx.actor)),
			});
		}
		// listByProjectAndState requires a project, so the unscoped view walks
		// projects. Volume is tiny relative to runs (one plan-run per
		// dispatched plan, not per child). `state` undefined means every state.
		{
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
 * `POST /plan-runs/:id/resume` — re-drive the SAME plan-run row after a
 * merge-timeout failure (warren-1eff, Option A). Only the two
 * human-merge-stall failure reasons (`child_pr_merge_timeout`,
 * `parent_pr_merge_timeout`) are resumable; anything else — including a
 * non-failed plan-run — gets a typed 409 from StateTransitionError with
 * no state change. The orchestration is `resumePlanRun` in the domain;
 * the coordinator picks the row up on its next tick and re-polls the
 * existing PR against a re-armed merge clock.
 */
export function resumePlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const result = await resumePlanRun({
			planRunId: requireParam(ctx, "id"),
			repos: deps.repos,
			emit: buildDefaultPlanRunEmit(deps.repos, deps.now),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, result);
	};
}

/**
 * `GET /plan-runs/:id/events` — NDJSON tail of the union of every child
 * run's events. Read-only: snapshots `events.listByRunIds(...)` first,
 * then subscribes to the broker for each child run. Live arrivals after
 * the snapshot are deduped by (runId, sandboxEventSeq). The generator is
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
