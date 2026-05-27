/**
 * `POST /plot-plan-runs` handler (warren-99b2 / pl-f404 step 3 / SPEC §11.Q).
 *
 * Extracted from `src/server/handlers/index.ts` (warren-48de / pl-9088 step 1).
 * The shared parsing helpers (`readJsonBody`, `requireString`,
 * `optionalString`) are re-imported from the index module so the wire
 * contract stays byte-identical across the split.
 */

import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import {
	PlanHasNoOpenChildrenError,
	ProjectLacksPlotError,
	ProjectLacksSeedsError,
} from "../../plan-runs/errors.ts";
import {
	defaultPlanRunPlotAppender,
	emitPlanRunDispatchedToPlot,
} from "../../plan-runs/plot-appender.ts";
import { NoDispatchableSeedsError } from "../../plot-plan-runs/index.ts";
import {
	defaultPlotReader,
	isValidPlotIdFormat,
	PlotIdInvalidError,
	PlotIdNotFoundError,
} from "../../plots/index.ts";
import { resolveDispatcherHandle } from "../../runs/index.ts";
import { showPlan, showSeed } from "../../seeds-cli/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalString, readJsonBody, requireString } from "./index.ts";

/**
 * `seeds_issue` attachments whose `ref` shape looks like a seeds plan
 * id (`pl-*`) are excluded from synthesis. They already have a per-row
 * "Run plan" dispatch path on PlotDetail (warren-5d94) and should be
 * dispatched as plans, not adopted as plan-run children. Mirrors the
 * UI-side `isSdPlanAttachment` predicate (src/ui/src/pages/PlotDetail.tsx).
 */
function isSdPlanAttachmentRef(ref: string): boolean {
	return /^pl-/i.test(ref);
}

/**
 * `POST /plot-plan-runs` — synthesize a seeds plan from a Plot's open
 * `seeds_issue` attachments, then dispatch it through the same machinery
 * as `POST /plan-runs`. See SPEC §11.Q for the full design.
 *
 * Handler order:
 *   (1) validate plot_id format (`PlotIdInvalidError`, warren-bae5).
 *   (2) load project by `project_id` from the body (NotFoundError → 404).
 *   (3) `project.hasPlot` gate (`ProjectLacksPlotError`, mirrors POST
 *       /plan-runs at mx-afe7e0).
 *   (4) `project.hasSeeds` gate (`ProjectLacksSeedsError`, mirrors POST
 *       /plan-runs). Order matches §11.P's gate-stack convention —
 *       seeds-first means plot_id never short-circuits the .seeds/
 *       requirement (warren-909c / pl-7937 step 6); the symmetric
 *       reasoning applies here even though the surface mandates plot_id.
 *   (5) verify the plot exists in this project's `.plot/` index via
 *       `plotResolver` (`PlotIdNotFoundError`, warren-bae5).
 *   (6) read the Plot envelope, filter `attachments` to open
 *       `seeds_issue` refs that are NOT `pl-*` shaped (the latter would
 *       dispatch via the per-plan button, not synthesis). The seed-
 *       status check shells out per-candidate via `showSeed` — same
 *       pattern as POST /plan-runs.
 *   (7) if zero candidates remain → `NoDispatchableSeedsError` (400).
 *   (8) synthesize: mint a fresh throwaway parent seed, submit a plan
 *       whose `steps[]` adopt the candidates via `existing_seed`
 *       (seeds-cli 0.4.7, warren-d519).
 *   (9) showPlan on the freshly synthesized plan — same shape POST
 *       /plan-runs reads — and run agent resolve + create + Plot
 *       append exactly like POST /plan-runs does (no shortcut path,
 *       so every §11.P / §11.P.Plot wiring lights up unmodified).
 *   (10) return 201 with `{planRun, children, synthesizedPlanId,
 *        parentSeedId}` — same `{planRun, children}` shape POST
 *        /plan-runs returns, plus two synthesis-specific fields so
 *        the UI can navigate to `/plan-runs/:id` AND surface the
 *        synthesized plan id for debugging.
 */
function createPlotPlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const plotId = requireString(body, "plot_id");
		const projectId = requireString(body, "project_id");
		const agentName = requireString(body, "agent_name");
		const promptTemplate = optionalString(body, "prompt_template");
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "provider_override");
		const modelOverride = optionalString(body, "model_override");
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		// (1) plot_id format validation (warren-bae5 / pl-5310 step 2). Done
		// up-front so a malformed id never reaches the project lookup.
		if (!isValidPlotIdFormat(plotId)) {
			throw new PlotIdInvalidError(
				`plot_id ${JSON.stringify(plotId)} is not a valid Plot ID (expected shape: plot-<lower-alphanum>+)`,
				{
					recoveryHint:
						"Plot IDs look like `plot-3e72876d`. Visit /plots to copy the canonical id of an existing Plot.",
				},
			);
		}

		// (2) project lookup.
		const project = await deps.repos.projects.require(projectId);

		// (3) hasPlot gate — same shape as POST /plots and POST /plan-runs.
		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} has no .plot/ directory; cannot synthesize a plan-run from a Plot`,
				{
					recoveryHint:
						"run `plot init` in the project clone and refresh the project so warren picks up the .plot/ directory",
				},
			);
		}

		// (4) hasSeeds gate — synthesis writes via `sd plan submit` so a
		// project without .seeds/ has nowhere to land the plan.
		if (!project.hasSeeds) {
			throw new ProjectLacksSeedsError(
				`project ${project.id} has no .seeds/ directory; cannot synthesize a plan-run`,
				{
					recoveryHint: "add a .seeds/ directory to the project clone and refresh",
				},
			);
		}

		// (5) plot_id existence — resolver returns the owning project, or
		// null when no `hasPlot=true` project's index contains the id.
		// `null` and "owns a different project" both surface as
		// `PlotIdNotFoundError` so the caller's body is consistent.
		if (deps.plotResolver !== undefined) {
			const owning = await deps.plotResolver.resolve(plotId);
			if (owning === null || owning.id !== project.id) {
				throw new PlotIdNotFoundError(
					`plot_id ${plotId} does not match any Plot in project ${project.id}`,
					{
						recoveryHint: "verify the Plot exists at /plots and is owned by the named project",
					},
				);
			}
		}

		// (6) read the Plot envelope and filter to dispatchable candidates.
		const reader = deps.plotReader ?? defaultPlotReader;
		const envelope = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});
		const seedsCandidates = envelope.attachments.filter(
			(a) => a.type === "seeds_issue" && !isSdPlanAttachmentRef(a.ref),
		);

		// Seeds CLI is required from here on (status probe + synthesis +
		// post-synthesis showPlan all shell out). Reject early with the
		// same shape POST /plan-runs uses.
		if (deps.seedsCli === undefined) {
			throw new ValidationError(
				"seeds CLI is not configured on this warren; plot-plan-runs require sd",
				{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
			);
		}
		const seedsCli = deps.seedsCli;

		// Closed seeds are dropped at the handler edge (plan-creation should
		// be intentional, not a silent skip). Status probe is parallel —
		// each call is shell + filesystem read.
		const statuses = await Promise.all(
			seedsCandidates.map((a) =>
				showSeed(seedsCli, project.localPath, a.ref).then((s) => ({
					ref: a.ref,
					status: s.status,
				})),
			),
		);
		const dispatchableRefs = statuses.filter((s) => s.status !== "closed").map((s) => s.ref);

		// (7) zero dispatchable → typed 400.
		if (dispatchableRefs.length === 0) {
			throw new NoDispatchableSeedsError(
				`Plot ${plotId} has no dispatchable seeds_issue attachments (all are closed, sd_plan-shaped, or missing)`,
				{
					recoveryHint:
						"attach open seeds_issue items to this Plot first, or close and re-create the Plot if all attached seeds are already merged",
				},
			);
		}

		// (8) synthesize. The synthesizer mints a parent seed + plan via
		// two `sd` shell-outs; failures bubble as SdPlanSynthesisError
		// (500-mapped) so a downstream consumer can distinguish synthesis
		// failure from the typed handler-edge rejects.
		if (deps.planSynthesizer === undefined) {
			throw new ValidationError("plot-plan-run synthesis is not configured on this warren", {
				recoveryHint: "ensure seeds CLI is configured and bootServer wires planSynthesizer",
			});
		}
		const synthesized = await deps.planSynthesizer.synthesize({
			projectPath: project.localPath,
			plotId,
			candidateSeedIds: dispatchableRefs,
		});

		// (9) re-read the synthesized plan via the same showPlan path
		// POST /plan-runs uses, then walk children to confirm at least
		// one is open. (This double-read is paid against the just-
		// committed plan, so it always succeeds in practice; keeping the
		// reuse of POST /plan-runs's contract is worth the extra read.)
		const plan = await showPlan(seedsCli, project.localPath, synthesized.planId);
		if (plan.children.length === 0) {
			throw new PlanHasNoOpenChildrenError(
				`synthesized plan ${synthesized.planId} has no children; nothing to dispatch`,
				{
					recoveryHint:
						"this is an internal warren state — re-attach open seeds_issue items to the Plot and retry POST /plot-plan-runs",
				},
			);
		}

		// Resolve agent with project-tier fallback (mirrors POST /plan-runs).
		const agent = await deps.repos.agents.resolve(agentName, { projectId: project.id });
		if (agent === null) {
			throw new NotFoundError(`agent not found: ${agentName}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}

		// Persist plan_run + plan_run_children + plotId.
		const result = await deps.repos.planRuns.create({
			planId: synthesized.planId,
			projectId: project.id,
			agentName: agent.name,
			children: plan.children.map((seedId, index) => ({ seq: index + 1, seedId })),
			...(promptTemplate !== undefined ? { promptTemplate } : {}),
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			plotId,
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});

		// Plot append (mirrors POST /plan-runs at mx-92e6b3 — fire-and-log
		// per defaultPlotAppender; a Plot-write failure logs and the 201
		// still ships).
		await emitPlanRunDispatchedToPlot({
			appender: deps.planRunPlotAppender ?? defaultPlanRunPlotAppender,
			logger: deps.logger,
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle: resolveDispatcherHandle(result.planRun.dispatcherHandle),
			planRunId: result.planRun.id,
			planId: result.planRun.planId,
			childrenCount: result.children.length,
		});

		// (10) response — POST /plan-runs's `{planRun, children}` shape,
		// plus synthesis-specific fields so the UI can render both the
		// PlanRun navigation target AND the synthesized plan id.
		return jsonResponse(201, {
			planRun: result.planRun,
			children: result.children,
			synthesizedPlanId: synthesized.planId,
			parentSeedId: synthesized.parentSeedId,
		});
	};
}

export { createPlotPlanRunHandler };
