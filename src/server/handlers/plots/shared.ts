/**
 * Shared helpers for the Plot HTTP handler domain (warren-332b / pl-369d).
 *
 * Extracted from `src/server/handlers/plots.ts` so the per-domain handler
 * files (`detail.ts`, `intent.ts`, `status.ts`, `attachments.ts`) can share
 * the resolve-project / build-envelope / paused-runs plumbing without
 * duplicating it. The wire contract stays byte-identical across the split —
 * the error messages and recovery hints below mirror the originals verbatim.
 */

import { join } from "node:path";
import { NotFoundError } from "../../../core/errors.ts";
import type { ProjectRow } from "../../../db/schema.ts";
import { ProjectLacksPlotError } from "../../../plan-runs/errors.ts";
import { defaultPlanChildAdopter, type PlotEnvelope } from "../../../plots/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { DEFAULT_AGENT_PAUSE_TIMEOUT_MS, loadWarrenConfig } from "../../../warren-config/index.ts";
import type { ServerDeps } from "../../types.ts";

/** Per-plot paused-run row surfaced on the PlotDetail envelope. */
export interface PausedRunRow {
	run_id: string;
	paused_at: string;
	paused_question_event_id: string;
	pause_timeout_ms: number;
}

/**
 * Resolve `paused_runs[]` for a Plot envelope (warren-4ea4 /
 * pl-0344 step 12). Each row is the narrow PlotDetail-facing subset:
 * `{run_id, paused_at, paused_question_event_id, pause_timeout_ms}`.
 * The timeout budget mirrors `resolveBudget()` in `src/runs/pause.ts`
 * — per-project `agent.pauseTimeoutMs` (via the WarrenConfigCache when
 * wired, else `loadWarrenConfig` direct read), falling back to
 * `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` on any config error so the UI
 * countdown always has a number to anchor on.
 *
 * Rows missing `paused_at` or `paused_question_event_id` are skipped
 * defensively — the pause detector always stamps both on transition
 * (warren-2976), but a hand-crafted/malformed row should not crash the
 * envelope.
 */
export async function loadPausedRunsForPlot(
	deps: ServerDeps,
	plotId: string,
	project: { id: string; localPath: string },
): Promise<PausedRunRow[]> {
	const rows = await deps.repos.runs.listByPlotId(plotId);
	const paused = rows.filter((r) => r.state === "paused");
	if (paused.length === 0) return [];
	let pauseTimeoutMs = DEFAULT_AGENT_PAUSE_TIMEOUT_MS;
	try {
		const cfg = await (deps.warrenConfigs !== undefined
			? deps.warrenConfigs.get(project.id, project.localPath)
			: loadWarrenConfig({ projectPath: project.localPath }));
		const value = cfg.defaults?.agent?.pauseTimeoutMs;
		if (typeof value === "number" && Number.isFinite(value)) pauseTimeoutMs = value;
	} catch {
		// fall through to default
	}
	const out: PausedRunRow[] = [];
	for (const r of paused) {
		if (r.pausedAt === null || r.pausedQuestionEventId === null) continue;
		out.push({
			run_id: r.id,
			paused_at: r.pausedAt,
			paused_question_event_id: r.pausedQuestionEventId,
			pause_timeout_ms: pauseTimeoutMs,
		});
	}
	return out;
}

/**
 * Resolve the owning project for a plot and run the defensive `hasPlot`
 * re-check shared by every `/plots/:id*` handler.
 *
 *   (1) resolve the owning project via `deps.plotResolver`. `null` (or no
 *       resolver wired, i.e. a non-Plot deployment) → typed 404 so the
 *       empty-deployments contract stays stable.
 *   (2) defensive `hasPlot` re-check — the resolver only walks
 *       `hasPlot=true` projects, but the flag could flip between the
 *       aggregator's cached read and this lookup. Surface as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) so HTTP
 *       consumers see one stable code across handlers.
 *
 * `action` is the verb phrase spliced into the `hasPlot` failure message
 * (e.g. `"read plot"`, `"edit intent on plot"`), formatted as
 * `cannot ${action} ${plotId}` to match the original per-handler text.
 */
export async function resolvePlotProject(
	deps: ServerDeps,
	plotId: string,
	action: string,
): Promise<ProjectRow> {
	const project = deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
	if (project === null) {
		throw new NotFoundError(`plot not found: ${plotId}`, {
			recoveryHint:
				"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
		});
	}
	if (!project.hasPlot) {
		throw new ProjectLacksPlotError(
			`project ${project.id} no longer has a .plot/ directory; cannot ${action} ${plotId}`,
			{
				recoveryHint:
					"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
			},
		);
	}
	return project;
}

/**
 * Best-effort reconciliation of a Plot's `sd_plan` attachments with the
 * children of the plans they reference (warren-18a9). Runs BEFORE the
 * read on `GET /plots/:id` so any newly adopted child appears in the
 * same response.
 *
 * No-op (and zero shell-outs) when the project has no `.seeds/` or no
 * seeds CLI is wired — the adopter shells out to `sd plan show`, so
 * both are prerequisites. Failures are swallowed + logged: a stale plan
 * ref or sd hiccup must never break the Plot read. On a non-empty
 * adoption the aggregator cache is invalidated so a follow-up
 * `GET /plots` sees the new `attachments_count` without the TTL wait.
 */
export async function reconcilePlanChildAttachments(
	deps: ServerDeps,
	plotId: string,
	project: ProjectRow,
): Promise<void> {
	if (deps.seedsCli === undefined || !project.hasSeeds) return;
	const adopter = deps.planChildAdopter ?? defaultPlanChildAdopter;
	try {
		const result = await adopter.adopt({
			plotDir: join(project.localPath, ".plot"),
			projectPath: project.localPath,
			plotId,
			handle: resolveDispatcherHandle(undefined),
			seedsCli: deps.seedsCli,
		});
		if (result.adopted.length > 0) {
			deps.plotAggregator?.invalidate(project.id);
			deps.logger.info(
				{ plotId, projectId: project.id, adopted: result.adopted },
				"plot.plan_children_adopted",
			);
		}
	} catch (err) {
		deps.logger.warn(
			{
				plotId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"plot.plan_child_adopt_failed",
		);
	}
}

/** Shape produced by the plot read/write seams (the per-project subset). */
interface PlotEnvelopeResult {
	id: string;
	name: string;
	status: PlotEnvelope["status"];
	intent: PlotEnvelope["intent"];
	attachments: PlotEnvelope["attachments"];
	event_log: PlotEnvelope["event_log"];
}

/**
 * Stitch a full `PlotEnvelope` from a seam result + the resolved
 * `project_id` + the per-plot paused-run rows. Pure assembly — keeps the
 * wire shape identical across every handler that returns a full envelope.
 */
export function buildPlotEnvelope(
	result: PlotEnvelopeResult,
	projectId: string,
	pausedRuns: PausedRunRow[],
): PlotEnvelope {
	return {
		id: result.id,
		name: result.name,
		status: result.status,
		intent: result.intent,
		attachments: result.attachments,
		event_log: result.event_log,
		project_id: projectId,
		paused_runs: pausedRuns,
	};
}
