/**
 * Plot HTTP handlers (warren-c167 / pl-9d6a, warren-d22e / pl-0344, …).
 *
 * Extracted from `src/server/handlers/index.ts` (warren-48de / pl-9088 step 1).
 * The shared parsing helpers (`readJsonBody`, `readJsonBodyOrEmpty`,
 * `requireString`, `optionalString`, `requireParam`, `defaultSpawn`)
 * are re-imported from the index module so the wire contract stays
 * byte-identical across the split.
 */

import { join } from "node:path";
import {
	ATTACHMENT_TYPES,
	type AttachmentType,
	PLOT_STATUSES,
	type PlotStatus,
} from "@os-eco/plot-cli";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { ProjectLacksPlotError } from "../../plan-runs/errors.ts";
import {
	defaultPlotAttacher,
	defaultPlotIntentEditor,
	defaultPlotPrMerger,
	defaultPlotReader,
	defaultPlotRenamer,
	defaultPlotStatusChanger,
	type PlotEnvelope,
	type PlotSummary,
	type PlotSummaryArtifact,
	summarizePlot,
} from "../../plots/index.ts";
import { refreshProject } from "../../projects/index.ts";
import { resolveDispatcherHandle } from "../../runs/index.ts";
import { DEFAULT_AGENT_PAUSE_TIMEOUT_MS, loadWarrenConfig } from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import {
	defaultSpawn,
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
} from "./index.ts";
import { triggerBackgroundSync } from "./plots/sync.ts";

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
async function loadPausedRunsForPlot(
	deps: ServerDeps,
	plotId: string,
	project: { id: string; localPath: string },
): Promise<
	Array<{
		run_id: string;
		paused_at: string;
		paused_question_event_id: string;
		pause_timeout_ms: number;
	}>
> {
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
	const out: Array<{
		run_id: string;
		paused_at: string;
		paused_question_event_id: string;
		pause_timeout_ms: number;
	}> = [];
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
 * `GET /plots/:id` — full Plot envelope by id (warren-961e /
 * pl-9d6a step 8).
 *
 * Handler order:
 *   (1) resolve the owning project via `deps.plotResolver`
 *       (built on top of `plotAggregator`'s per-project cache so the
 *       typical UI flow — `GET /plots` followed by `GET /plots/:id` —
 *       does at most one index read per project within the 5s TTL).
 *       `null` → typed 404. When no resolver is wired (non-Plot
 *       deployment), the handler also returns 404 so the
 *       empty-deployments contract stays stable.
 *   (2) defensive `hasPlot` re-check — the resolver only walks
 *       `hasPlot=true` projects, but the flag could have flipped
 *       between the aggregator's cached read and this lookup.
 *       Surface as `ProjectLacksPlotError` (same 400 envelope the
 *       create/dispatch paths use) so HTTP consumers see one stable
 *       `project_lacks_plot` code across handlers.
 *   (3) hand off to `deps.plotReader` (default `defaultPlotReader`),
 *       which opens a `UserPlotClient` against `<project>/.plot/`,
 *       snapshots `read()` + `events()` in parallel, and returns the
 *       per-project envelope subset. The handler stitches `project_id`
 *       on top to build the wire shape.
 *
 * `event_log` is returned in ascending `at` order — the reader sorts
 * defensively so the wire contract doesn't depend on the Plot
 * library's internal append order. The UI collapses long chains of
 * same-kind same-actor events client-side (see warren-bdbf).
 */
function getPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");

		// (1) resolve owning project. No resolver wired → 404 (same
		// posture as the byte-identical empty contract on GET /plots).
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (2) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot read plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (3) read full envelope.
		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
	};
}

/**
 * `GET /plots/:id/summary` — curated artifact view (warren-8917 /
 * pl-0344 step 15). Same resolver + reader stack as `GET /plots/:id`,
 * but the response is the institutional-memory projection produced by
 * `summarizePlot`: formatted intent, decisions filtered by
 * `decision_made`, linked PRs (with merge audit trail) + commits, and
 * a curated structural timeline. Pure derivation — no extra IO beyond
 * the reader.
 */
function getPlotSummaryHandler(deps: ServerDeps): RouteHandler {
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
				`project ${project.id} no longer has a .plot/ directory; cannot read plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}
		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});
		const artifact: PlotSummaryArtifact = summarizePlot({
			id: result.id,
			name: result.name,
			status: result.status,
			project_id: project.id,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
		});
		return jsonResponse(200, artifact);
	};
}

/**
 * `POST /plots/:id/intent` — edit a Plot's intent body (warren-896f /
 * pl-9d6a step 9).
 *
 * Handler order:
 *   (1) parse + validate the body's `intent` patch shape (reuses
 *       `parseIntentPatch` from `POST /plots` so the wire contract is
 *       symmetric — unknown fields like `goals`/`nongoals` reject at
 *       the handler edge).
 *   (2) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (3) resolve the owning project via `deps.plotResolver` (same
 *       cache-backed path as `GET /plots/:id`); `null` → 404. No
 *       resolver wired (non-Plot deployment) also → 404 so the
 *       empty-deployments contract stays stable.
 *   (4) defensive `hasPlot` re-check (the resolver only walks
 *       `hasPlot=true` rows, but the flag can flip out from under us
 *       between calls). Surface as `ProjectLacksPlotError` (400 /
 *       `project_lacks_plot`) for the same envelope the create /
 *       dispatch paths use.
 *   (5) hand off to `deps.plotIntentEditor` (default
 *       `defaultPlotIntentEditor`) which opens a `UserPlotClient`,
 *       enforces SPEC §6's frozen-at-done rule (`PlotIntentFrozenError`
 *       → 409 / `plot_intent_frozen`), applies the patch via
 *       `PlotHandle.editIntent`, and returns the fresh envelope subset.
 *       Failure propagates synchronously — NOT fire-and-log (mx-92e6b3
 *       contrasts: PlanRun's plot-append IS fire-and-log because the
 *       user is waiting on the PlanRun, not the Plot mirror; here the
 *       user is waiting on the intent edit itself).
 *   (6) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new `intent_goal_preview`
 *       without the 5s TTL wait.
 *   (7) return 200 with the full `PlotEnvelope` (per-project subset +
 *       `project_id` from the resolved row).
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

		// (1) parse the intent patch — flat top-level fields here (the
		// create endpoint wraps under `intent`, see parseIntentPatch).
		const patch = parseTopLevelIntentPatch(body);

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot edit intent on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the editor seam.
		const editor = deps.plotIntentEditor ?? defaultPlotIntentEditor;
		const result = await editor.edit({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			patch: patch ?? {},
		});

		// (6) drop the aggregator cache so the next list sees the new
		// `intent_goal_preview` without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — full PlotEnvelope.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
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
 *   (3) resolve the owning project via `deps.plotResolver`; `null` → 404.
 *   (4) defensive `hasPlot` re-check (→ 400 `project_lacks_plot`).
 *   (5) hand off to `deps.plotRenamer` (default `defaultPlotRenamer`),
 *       which opens a `UserPlotClient`, mutates `plot.json#/name`, and
 *       appends a `note` event recording the from→to transition.
 *       Failure surfaces synchronously — NOT fire-and-log.
 *   (6) invalidate the aggregator's cache entry for the project so a
 *       follow-up `GET /plots` sees the new name without the 5s TTL wait.
 *   (7) return 200 with the full `PlotEnvelope`.
 *
 * Renames are allowed in every status. The name is pure metadata — the
 * SPEC §6 frozen-at-done rule applies only to the intent body.
 */
function renamePlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse the rename body.
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

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot rename plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the renamer seam.
		const renamer = deps.plotRenamer ?? defaultPlotRenamer;
		const result = await renamer.rename({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			name: trimmedName,
		});

		// (6) drop aggregator cache so a follow-up list sees the new name.
		deps.plotAggregator?.invalidate(project.id);

		// (7) wire response — full PlotEnvelope.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, envelope);
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
function parseTopLevelIntentPatch(
	body: Record<string, unknown>,
): import("../../plots/index.ts").EditPlotIntentPatch | undefined {
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
 *   (3) resolve the owning project via `deps.plotResolver`; `null`
 *       or unwired resolver → 404 (empty-deployments contract).
 *   (4) defensive `hasPlot` re-check — surfaces as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) for the
 *       same envelope the create / intent paths use.
 *   (5) hand off to `deps.plotStatusChanger` (default
 *       `defaultPlotStatusChanger`) which opens a `UserPlotClient`,
 *       runs the SPEC §6.5 transition matrix
 *       (`assertStatusTransitionAllowed`) against the on-disk current
 *       status, calls `setStatus(next)`, and snapshots the fresh
 *       summary + `status_changed` event. Failure propagates
 *       synchronously — NOT fire-and-log (mx-92e6b3 contrasts:
 *       PlanRun's plot-append IS fire-and-log because the user is
 *       waiting on the PlanRun, not the Plot mirror; here the user is
 *       waiting on the transition itself).
 *   (6) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new status (and the
 *       refreshed `last_event_ts`/`last_event_actor`) without the 5s
 *       TTL wait.
 *   (7) return 200 with `{ summary: PlotSummary, event: PlotEvent }`
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

		// (1) parse + validate `next`.
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

		// (2) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (3) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (4) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot change status on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (5) delegate to the changer seam. The changer reads the current
		// status from disk and re-runs `assertStatusTransitionAllowed`
		// before calling `setStatus`; warren never constructs an invalid
		// transition (defense in depth on top of the lib's own guard).
		const changer = deps.plotStatusChanger ?? defaultPlotStatusChanger;
		const result = await changer.change({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			next,
		});

		// (6) drop the aggregator cache so the next list sees the new
		// status / last_event_ts without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// Trigger background sync
		triggerBackgroundSync(deps, project, plotId);

		// (7) wire response — PlotSummary + the emitted status_changed event.
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

/**
 * Per-kind ref-shape patterns enforced at the handler edge (warren-589c).
 *
 * The lib only checks `ref.minLength >= 1`. Warren narrows this further
 * so typos / wrong-kind refs reject before the disk round-trip. Kinds
 * without a defined pattern fall through to the lib's min-length check.
 *
 * SPEC §3.1 leaves `ref` free-form, but the conventional shapes are
 * tractable:
 *   - `seeds_issue`  → `<project>-<4 hex>` (seeds id format).
 *   - `mulch_record` → `mx-<6 hex>` (mulch record id format).
 *   - `agent_run`    → `run-<...>` (warren run id format, prefix
 *                                      check only — the suffix shape
 *                                      varies across deployments).
 *   - `gh_pr`        → free-form (PRs use full URLs / owner/repo#N).
 *   - `gh_issue`     → free-form (same).
 *   - `file`         → free-form (paths are arbitrary).
 */
const ATTACHMENT_REF_PATTERNS: Partial<Record<AttachmentType, RegExp>> = {
	seeds_issue: /^[a-z0-9_-]+-[a-f0-9]{4}$/,
	mulch_record: /^mx-[a-f0-9]{6}$/,
	agent_run: /^run-[A-Za-z0-9_-]+$/,
};

/**
 * `POST /plots/:id/attachments` — attach an external reference to a
 * Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) parse + validate `kind` against `ATTACHMENT_TYPES` (the lib's
 *       enum). The seed body lists six wire kinds; the lib's enum is
 *       the source of truth, so kinds outside
 *       `seeds_issue|mulch_record|agent_run|gh_pr|gh_issue|file` are
 *       rejected with 400. Per-kind ref shape is then validated via
 *       `ATTACHMENT_REF_PATTERNS` (e.g. `seeds_issue` ref matches
 *       `/^[a-z0-9_-]+-[a-f0-9]{4}$/`).
 *   (2) parse + validate `ref` (non-empty string) and the optional
 *       `role` (non-empty string when present).
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (4) resolve the owning project via `deps.plotResolver`; `null` or
 *       unwired resolver → 404 (empty-deployments contract).
 *   (5) defensive `hasPlot` re-check — surfaces as
 *       `ProjectLacksPlotError` (400 / `project_lacks_plot`) for
 *       parity with the create / intent / status paths.
 *   (6) hand off to `deps.plotAttacher` (default `defaultPlotAttacher`)
 *       which opens a `UserPlotClient` and calls `PlotHandle.attach`.
 *       Failure propagates synchronously — NOT fire-and-log.
 *   (7) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new `attachments_count`
 *       without the 5s TTL wait.
 *   (8) return 200 with `{ envelope: PlotEnvelope, attachment: Attachment }`
 *       so the UI can splice the new attachment into its optimistic
 *       state without re-rendering the entire envelope.
 *
 * ACL note: `UserPlotClient` exclusively (via the attacher seam).
 * Agent actors are not routed through this handler — see SPEC §6 —
 * but `attach` is permitted on `AgentPlotHandle` too; threading the
 * write through the user-typed seam keeps the actor on the wire log
 * consistent with the intent/status writes.
 */
function attachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) parse + validate `kind`.
		const rawKind = body.kind;
		if (typeof rawKind !== "string") {
			throw new ValidationError("field 'kind' must be a string");
		}
		if (!(ATTACHMENT_TYPES as readonly string[]).includes(rawKind)) {
			throw new ValidationError(
				`unknown kind '${rawKind}'; expected one of ${ATTACHMENT_TYPES.join(", ")}`,
			);
		}
		const kind = rawKind as AttachmentType;

		// (2) parse + validate `ref` and `role`.
		const rawRef = body.ref;
		if (typeof rawRef !== "string" || rawRef.length === 0) {
			throw new ValidationError("field 'ref' must be a non-empty string");
		}
		const refPattern = ATTACHMENT_REF_PATTERNS[kind];
		if (refPattern !== undefined && !refPattern.test(rawRef)) {
			throw new ValidationError(
				`field 'ref' does not match the expected shape for kind '${kind}' (pattern: ${refPattern.source})`,
			);
		}
		let role: string | undefined;
		if (body.role !== undefined) {
			if (typeof body.role !== "string" || body.role.length === 0) {
				throw new ValidationError("field 'role' must be a non-empty string when present");
			}
			role = body.role;
		}

		// (3) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (4) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (5) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot attach to plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (6) delegate to the attacher seam.
		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.attach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			kind,
			ref: rawRef,
			...(role !== undefined ? { role } : {}),
		});

		// (7) drop the aggregator cache so the next list sees the new
		// attachments_count / last_event_ts without waiting for the 5s TTL.
		deps.plotAggregator?.invalidate(project.id);

		// (8) wire response — full PlotEnvelope + the freshly added attachment.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, { envelope, attachment: result.attachment });
	};
}

/**
 * `DELETE /plots/:id/attachments/:ref` — detach an external reference
 * from a Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) decode the `:ref` URL param (the router already runs
 *       `decodeURIComponent` per `src/server/router.ts`) and reject
 *       empty refs at the edge.
 *   (2) parse the optional `dispatcher_handle` from the request body
 *       (DELETE bodies are spec-legal under fetch and Bun.serve). When
 *       no body is provided we accept that and fall through to the
 *       `operator` fallback.
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`.
 *   (4) resolve the owning project via `deps.plotResolver`; `null` or
 *       unwired resolver → 404 (empty-deployments contract).
 *   (5) defensive `hasPlot` re-check — `ProjectLacksPlotError` (400).
 *   (6) hand off to `deps.plotAttacher.detach` (default
 *       `defaultPlotAttacher`) which reads the Plot, maps the ref to
 *       the lib's `att-NNN` id, and calls `PlotHandle.detach`.
 *       `PlotAttachmentNotFoundError` (404) surfaces when the ref
 *       doesn't match any current attachment.
 *   (7) invalidate the aggregator cache entry for the project.
 *   (8) return 200 with `{ envelope: PlotEnvelope, removed_id }`.
 */
function detachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		// (2) optional body. DELETE bodies are rare — readJsonBodyOrEmpty
		// returns null for empty payloads so the call stays optional.
		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;

		// (3) handle resolution.
		const handle = resolveDispatcherHandle(dispatcherHandle);

		// (4) resolve owning project.
		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		// (5) defensive hasPlot re-check.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot detach from plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		// (6) delegate to the attacher seam.
		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.detach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
		});

		// (7) drop the aggregator cache.
		deps.plotAggregator?.invalidate(project.id);

		// (8) wire response — full PlotEnvelope + the removed attachment id.
		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, { envelope, removed_id: result.removed_id });
	};
}

/**
 * `POST /plots/:id/attachments/:ref/merge` — click-to-merge a
 * GitHub PR attachment (warren-8e39 / pl-0344 step 14).
 *
 * Handler order:
 *   (1) decode `:ref` (router runs decodeURIComponent) and reject
 *       empty refs at the edge.
 *   (2) optional body parses `dispatcher_handle` + `merge_method`
 *       (‘merge’ | ‘squash’ | ‘rebase’, default ‘merge’).
 *   (3) handle resolution via `resolveDispatcherHandle`.
 *   (4) resolve owning project via `deps.plotResolver`; `null` /
 *       unwired → 404.
 *   (5) defensive `hasPlot` re-check → `ProjectLacksPlotError`.
 *   (6) `deps.plotPrMerger.merge` resolves the gh_pr attachment,
 *       parses the ref, calls `mergePullRequest` against the GitHub
 *       REST API, and returns the post-merge Plot snapshot + the
 *       `MergePullRequestResult` variant. Errors:
 *         - `PlotAttachmentNotFoundError` (404) — unknown ref
 *         - `PlotPrAttachmentMismatchedKindError` (400) — wrong kind
 *         - `PlotPrAttachmentInvalidError` (400) — unparseable ref
 *   (7) on `merge.kind === "merged" | "already_merged"` schedule a
 *       background `refreshProject` so the local clone picks up the
 *       new merge commit. Fire-and-forget with structured-logger
 *       error handling — the wire response does NOT block on the
 *       refresh, the UI gets the merge outcome immediately and the
 *       follow-up clone state lands via the existing
 *       `last_refreshed_at` field on the project row (refreshed via
 *       the standard `/projects/:id/refresh` cycle, just kicked
 *       early here).
 *   (8) invalidate the aggregator cache entry for the project (the
 *       fresh event log on the envelope reflects any post-merge
 *       gardening the lib does).
 *   (9) return 200 with `{ envelope, merge, attachment_id,
 *       refresh_scheduled }`. The `merge` variant is surfaced
 *       verbatim so the UI renders rate-limit + error states
 *       without re-parsing the envelope.
 *
 * GitHub auth: `deps.autoOpenPr.token` already carries `GITHUB_TOKEN`
 * (same source the reap path uses for PR open). Tokenless
 * deployments surface `merge.kind === "missing_token"` so the UI
 * can hint the operator at the env var.
 */
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

function mergePlotPrAttachmentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;
		let mergeMethod: MergeMethod | undefined;
		if (body !== null && body.merge_method !== undefined) {
			const raw = body.merge_method;
			if (typeof raw !== "string" || !(MERGE_METHODS as readonly string[]).includes(raw)) {
				throw new ValidationError(
					`field 'merge_method' must be one of ${MERGE_METHODS.join(", ")} when present`,
				);
			}
			mergeMethod = raw as MergeMethod;
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
				`project ${project.id} no longer has a .plot/ directory; cannot merge attachment on plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		const merger = deps.plotPrMerger ?? defaultPlotPrMerger;
		const token = deps.autoOpenPr?.token ?? "";
		const result = await merger.merge({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
			token,
			...(mergeMethod !== undefined ? { mergeMethod } : {}),
		});

		let refreshScheduled = false;
		if (result.merge.kind === "merged" || result.merge.kind === "already_merged") {
			refreshScheduled = true;
			// Fire-and-forget background refresh so the local clone picks up
			// the new merge commit. The user already has the merge outcome
			// on the response; this is a follow-up sync.
			const projectId = project.id;
			void refreshProject({
				repo: deps.repos.projects,
				config: deps.projectsConfig,
				id: projectId,
				spawn: deps.spawn ?? defaultSpawn,
				...(deps.now !== undefined ? { now: deps.now } : {}),
				...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			})
				.then((res) => {
					deps.logger.info(
						{ projectId, headSha: res.headSha, plotId, ref },
						"background project refresh after PR merge",
					);
				})
				.catch((err: unknown) => {
					deps.logger.warn(
						{
							projectId,
							plotId,
							ref,
							err: err instanceof Error ? err.message : String(err),
						},
						"background project refresh after PR merge failed",
					);
				});
		}

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		const envelope: PlotEnvelope = {
			id: result.id,
			name: result.name,
			status: result.status,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
			project_id: project.id,
			paused_runs,
		};
		return jsonResponse(200, {
			envelope,
			merge: result.merge,
			attachment_id: result.attachment_id,
			refresh_scheduled: refreshScheduled,
		});
	};
}

export {
	attachPlotHandler,
	changePlotStatusHandler,
	detachPlotHandler,
	editPlotIntentHandler,
	getPlotHandler,
	getPlotSummaryHandler,
	mergePlotPrAttachmentHandler,
	renamePlotHandler,
};
