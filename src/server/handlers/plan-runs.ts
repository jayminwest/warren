/**
 * PlanRun HTTP handlers (warren-f923 / pl-a258 step 6).
 *
 * Extracted from `src/server/handlers/index.ts` (warren-a2b4 /
 * pl-9088 step 2). Shared parsing helpers and the
 * `assertPlotIdDispatchable` gate are re-imported from the index
 * module; the NDJSON streaming plumbing (`bridgeAbort`,
 * `asNdjsonStream`, `eventToNdjson`) is re-imported from `./runs.ts`
 * so the plan-run stream handler stays byte-identical to the
 * pre-split shape.
 */

import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import {
	PlanHasNoOpenChildrenError,
	ProjectLacksPlotError,
	ProjectLacksSeedsError,
} from "../../plan-runs/errors.ts";
import {
	defaultPlanRunPlotActivator,
	defaultPlanRunPlotAppender,
	emitPlanRunDispatchedToPlot,
	promotePlotToActiveOnDispatch,
} from "../../plan-runs/plot-appender.ts";
import { cancelRun, resolveDispatcherHandle } from "../../runs/index.ts";
import { showPlan, showSeed } from "../../seeds-cli/index.ts";
import { jsonResponse, ndjsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import {
	assertPlotIdDispatchable,
	optionalString,
	parseBoolean,
	readJsonBody,
	requireParam,
	requireString,
} from "./index.ts";
import { asNdjsonStream, bridgeAbort, eventToNdjson } from "./runs/index.ts";

/* ----------------------------------------------------------------------- */
/* Plan runs (warren-f923 / pl-a258 step 6)                                 */
/* ----------------------------------------------------------------------- */

const PLAN_RUN_ACCEPTED_PLAN_STATUSES = ["approved", "active", "done"] as const;
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
 *
 * Handler order (warren-f923):
 *   (1) load project; 404 if missing.
 *   (2) reject when project.hasSeeds is false (ProjectLacksSeedsError mirrors
 *       the plot reject shape at warren-a8c3 — same ValidationError → 400
 *       envelope, stable code so HTTP consumers can branch on it).
 *   (2b) reject when plot_id is set but project.hasPlot is false
 *       (ProjectLacksPlotError, warren-c900 / pl-7937 Phase 2). Same 400
 *       envelope; raised before the seeds-CLI fan-out so a non-Plot project
 *       never grows a half-validated plan-run.
 *
 *   Gates (2) and (2b) are **stacked, not independent** (warren-909c /
 *   pl-7937 step 6): seeds is the base, plot is the optional layer on top.
 *   A project missing .seeds/ is rejected as `project_lacks_seeds` even
 *   when plot_id is supplied — plot_id never short-circuits the .seeds/
 *   requirement, and PlanRun-with-plot only lights up when BOTH .seeds/
 *   AND .plot/ are present.
 *   (3) call showPlan; assert plan.status is in (approved, active, done) and
 *       at least one open child exists (PlanHasNoOpenChildrenError).
 *   (4) resolve agent via repos.agents.resolve with the project-tier fallback
 *       (mx-644fb5 — same posture as spawnRun).
 *   (5/6) build + persist plan_runs + plan_run_children rows in a single
 *       repo.create call (the repo runs them in a transaction so a half-
 *       inserted PlanRun never appears to listActive). plot_id rides through
 *       the same call (default null when omitted).
 *   (7) return 201 with {planRun, children}.
 */
export function createPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project");
		const planId = requireString(body, "planId");
		const agentName = requireString(body, "agent");
		const promptTemplate = optionalString(body, "promptTemplate");
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const plotId = optionalString(body, "plotId");

		// (1) project lookup — NotFoundError → 404.
		const project = await deps.repos.projects.require(projectId);

		// (2) hasSeeds gate.
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; plan-runs are not accepted`,
				{
					recoveryHint: "add a .seeds/ directory to the project clone and refresh",
				},
			);
		}

		// (2b) hasPlot gate — symmetric to single-run's spawn-time check
		// (src/runs/spawn/dispatch.ts, warren-a8c3). Empty-string plot_id is treated
		// as "not provided" to match the single-run handler's posture.
		if (plotId !== undefined && plotId !== "" && !project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; plot_id is not accepted`,
				{
					recoveryHint:
						"either omit plot_id on POST /plan-runs, or run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (2c) warren-bae5 / pl-5310 step 2: plot_id format + existence
		// validation, mirroring createRunHandler's check. Layered AFTER
		// ProjectLacksPlotError so the more-specific project-shape error
		// still wins when both apply.
		await assertPlotIdDispatchable({ plotId, plotResolver: deps.plotResolver });

		// (3) read the plan via seeds-cli.
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; plan-runs require sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const plan = await showPlan(deps.seedsCli, project.localPath, planId);
		if (!(PLAN_RUN_ACCEPTED_PLAN_STATUSES as readonly string[]).includes(plan.status)) {
			throw new ValidationError(
				`plan ${planId} is in status '${plan.status}'; plan-runs require one of ${PLAN_RUN_ACCEPTED_PLAN_STATUSES.join(", ")}`,
				{
					recoveryHint: "approve or activate the plan in seeds, then retry POST /plan-runs",
				},
			);
		}
		if (plan.children.length === 0) {
			throw new PlanHasNoOpenChildrenError(`plan ${planId} has no children; nothing to dispatch`, {
				recoveryHint: "run `sd plan submit <seed-id>` to populate the plan's children",
			});
		}
		// Probe every child seed's status — if all are already closed there is
		// nothing to dispatch. Each child is read in parallel since the seeds
		// CLI is shell-out + filesystem read, not network.
		const seedsCli = deps.seedsCli;
		const childStatuses = await Promise.all(
			plan.children.map((seedId) =>
				showSeed(seedsCli, project.localPath, seedId).then((s) => ({
					seedId,
					status: s.status,
				})),
			),
		);
		const hasOpenChild = childStatuses.some((c) => c.status !== "closed");
		if (!hasOpenChild) {
			throw new PlanHasNoOpenChildrenError(
				`plan ${planId} has no open children; every child seed is closed`,
				{
					recoveryHint: "re-open at least one child seed (sd update <id> --status open) and retry",
				},
			);
		}

		// (4) agent resolve with project-tier fallback (mx-644fb5).
		const agent = await deps.repos.agents.resolve(agentName, { projectId: project.id });
		if (agent === null) {
			throw new NotFoundError(`agent not found: ${agentName}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}

		// (5/6) persist.
		const result = await deps.repos.planRuns.create({
			planId,
			projectId: project.id,
			agentName: agent.name,
			children: plan.children.map((seedId, index) => ({ seq: index + 1, seedId })),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(plotId !== undefined && plotId !== "" ? { plotId } : {}),
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// (6b) warren-b89f / pl-7937 step 4: emit one `plan_run_dispatched`
		// event onto the bound Plot — fire-and-log, mirrors the single-run
		// `defaultPlotAppender` posture in src/runs/spawn/plot-append.ts. The
		// PlanRun row is durably persisted by this point, so a Plot-write
		// failure logs `plan_run.plot_append_failed` and the POST still
		// returns 201.
		if (result.planRun.plotId !== null) {
			await emitPlanRunDispatchedToPlot({
				appender: deps.planRunPlotAppender ?? defaultPlanRunPlotAppender,
				logger: deps.logger,
				plotDir: join(project.localPath, ".plot"),
				plotId: result.planRun.plotId,
				handle: resolveDispatcherHandle(result.planRun.dispatcherHandle),
				planRunId: result.planRun.id,
				planId: result.planRun.planId,
				childrenCount: result.children.length,
			});

			// (6c) warren-dfff / pl-e381 step 2: promote the bound Plot
			// `ready` → `active` at dispatch so the auto-done guard
			// (`status === 'active'`) is reachable via dispatch as well as
			// operator action. Fire-and-log; never affects the 201.
			await promotePlotToActiveOnDispatch({
				activator: deps.planRunPlotActivator ?? defaultPlanRunPlotActivator,
				logger: deps.logger,
				plotDir: join(project.localPath, ".plot"),
				plotId: result.planRun.plotId,
				handle: resolveDispatcherHandle(result.planRun.dispatcherHandle),
				planRunId: result.planRun.id,
			});
		}

		// (7) wire response — coordinator picks the row up on its next tick.
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
			return jsonResponse(200, { planRuns: rows });
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
			return jsonResponse(200, { planRuns: all });
		}
		return jsonResponse(200, { planRuns: await deps.repos.planRuns.listActive() });
	};
}

/**
 * `GET /plan-runs/:id` — full detail page payload: row + children + the
 * fanned-out `runs[]` from runs.listByIds(child.runId for each non-null)
 * so the UI's detail page renders in one round-trip.
 */
export function getPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		const children = await deps.repos.planRuns.listChildren(id);
		const runIds = children.map((c) => c.runId).filter((v): v is string => v !== null);
		const runs = await deps.repos.runs.listByIds(runIds);
		return jsonResponse(200, { planRun, children, runs });
	};
}

/**
 * `POST /plan-runs/:id/cancel` — flip the plan-run to `cancelled` and, if
 * a child run is in-flight (dispatched / running / pr_open), forward a
 * cancel to that child via the existing `cancelRun` seam.
 *
 * Idempotent against an already-terminal plan-run: returns the current row
 * without firing a second cancel.
 */
export function cancelPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		if (
			planRun.state === "cancelled" ||
			planRun.state === "succeeded" ||
			planRun.state === "failed"
		) {
			return jsonResponse(200, {
				planRun,
				cancelledChild: null,
				alreadyTerminal: true,
			});
		}

		const children = await deps.repos.planRuns.listChildren(id);
		const inFlight = children.find(
			(c) => c.state === "dispatched" || c.state === "running" || c.state === "pr_open",
		);

		const endedAt = (deps.now?.() ?? new Date()).toISOString();
		const cancelled = await deps.repos.planRuns.transitionTo(planRun.id, "cancelled", {
			endedAt,
		});

		let cancelledChild: { childSeq: number; runId: string } | null = null;
		if (inFlight !== undefined && inFlight.runId !== null) {
			try {
				await cancelRun({
					runId: inFlight.runId,
					repos: deps.repos,
					burrowClientPool: deps.burrowClientPool,
					broker: deps.broker,
					reason: `plan_run_cancelled:${planRun.id}`,
					...(deps.now !== undefined ? { now: deps.now } : {}),
					...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
				});
				cancelledChild = { childSeq: inFlight.seq, runId: inFlight.runId };
			} catch (err) {
				// Best-effort cancel — the plan-run itself is already in the
				// cancelled state, and the child run will land terminally via
				// the bridge regardless. Surface the failure on the response
				// so operators can see why the child didn't cancel cleanly.
				deps.logger.warn(
					{
						planRunId: planRun.id,
						childRunId: inFlight.runId,
						err: err instanceof Error ? err.message : String(err),
					},
					"plan_run.cancel_child_failed",
				);
			}
		}

		return jsonResponse(200, {
			planRun: cancelled,
			cancelledChild,
			alreadyTerminal: false,
		});
	};
}

/**
 * `GET /plan-runs/:id/events` — NDJSON tail of the union of every child
 * run's events. Read-only: snapshots `events.listByRunIds(...)` first,
 * then subscribes to the broker for each child run. Live arrivals after
 * the snapshot are deduped by (runId, burrowEventSeq).
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

		const source = tailPlanRunEvents({
			planRun,
			repos: deps.repos,
			broker: deps.broker,
			follow,
			signal: ctrl.signal,
		});
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, null), ctrl));
	};
}

interface TailPlanRunEventsInput {
	readonly planRun: { id: string };
	readonly repos: ServerDeps["repos"];
	readonly broker: ServerDeps["broker"];
	readonly follow: boolean;
	readonly signal: AbortSignal;
}

type PlanRunEventRow = {
	id: number;
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream: string | null;
	payloadJson: unknown;
};

/**
 * Tail the union of every plan-run child's events. History first (via
 * `events.listByRunIds`), then live arrivals from `broker.subscribe(runId)`
 * for each known child runId. Newly-dispatched children are picked up by a
 * polling watcher so a stream opened before child 2 lands still sees its
 * events without a reconnect.
 *
 * Live events are deduped by (runId, burrowEventSeq) against the high-water
 * mark established during history replay, so a row that lands in the gap
 * between snapshot and subscribe isn't either dropped or duplicated.
 */
async function* tailPlanRunEvents(
	input: TailPlanRunEventsInput,
): AsyncGenerator<PlanRunEventRow, void, void> {
	const seenSeq = new Map<string, number>();

	const initialChildren = await input.repos.planRuns.listChildren(input.planRun.id);
	const initialRunIds = initialChildren.map((c) => c.runId).filter((v): v is string => v !== null);
	const history = await input.repos.events.listByRunIds(initialRunIds);
	for (const row of history) {
		const prev = seenSeq.get(row.runId) ?? 0;
		if (row.burrowEventSeq > prev) seenSeq.set(row.runId, row.burrowEventSeq);
		yield row;
	}

	if (!input.follow) return;

	// Shared event queue fed by every per-child subscription pump.
	const queue: PlanRunEventRow[] = [];
	let waiter: (() => void) | null = null;
	const wake = (): void => {
		const fn = waiter;
		if (fn !== null) {
			waiter = null;
			fn();
		}
	};
	input.signal.addEventListener("abort", wake, { once: true });

	const subscribed = new Set<string>();
	const subscribe = (runId: string): void => {
		if (subscribed.has(runId)) return;
		subscribed.add(runId);
		const sub = input.broker.subscribe(runId, { signal: input.signal });
		void (async () => {
			try {
				for await (const row of sub) {
					queue.push(row as PlanRunEventRow);
					wake();
				}
			} catch {
				// broker.subscribe ends via signal abort or close — ignore.
			}
		})();
	};
	for (const runId of initialRunIds) subscribe(runId);

	const watcherIntervalMs = 2_000;
	const watcher = setInterval(() => {
		void (async () => {
			try {
				const fresh = await input.repos.planRuns.listChildren(input.planRun.id);
				for (const child of fresh) {
					if (child.runId !== null) subscribe(child.runId);
				}
			} catch {
				// Best-effort — a missed reload pings again next tick.
			}
		})();
	}, watcherIntervalMs);

	try {
		while (!input.signal.aborted) {
			const row = queue.shift();
			if (row === undefined) {
				await new Promise<void>((resolve) => {
					waiter = resolve;
				});
				continue;
			}
			const prev = seenSeq.get(row.runId) ?? 0;
			if (row.burrowEventSeq <= prev) continue;
			seenSeq.set(row.runId, row.burrowEventSeq);
			yield row;
		}
	} finally {
		clearInterval(watcher);
	}
}
