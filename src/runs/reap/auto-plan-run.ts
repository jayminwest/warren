import { readAutoPlanRunAgent } from "../../registry/schema.ts";
import { SeedNotFoundError, type SeedsCliDeps, showSeed } from "../../seeds-cli/index.ts";
import { splitLines } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Auto plan-run detection (warren-a32a)                                    */
/* ----------------------------------------------------------------------- */

/**
 * Coerce a frontmatter flag that *should* be a boolean but may arrive as a
 * string (warren-5f07). `cn --fm key:value` stringifies every value, so a
 * canopy-authored agent that sets `auto_plan_run: true` lands in
 * `rendered_agent_json` as the string `"true"` and silently loses
 * auto-dispatch. Accept the real boolean `true` and the case-insensitive,
 * trimmed string `"true"`; everything else (including `"false"`) is false.
 */
function coerceBooleanFlag(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
	return false;
}

export function hasAutoPlanRunFrontmatter(run: { renderedAgentJson: unknown }): boolean {
	const json = run.renderedAgentJson;
	if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
	const fm = (json as Record<string, unknown>).frontmatter;
	if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return false;
	return coerceBooleanFlag((fm as Record<string, unknown>).auto_plan_run);
}

export function resolveAutoPlanRunAgent(run: {
	renderedAgentJson: unknown;
	agentName: string;
}): string {
	const json = run.renderedAgentJson;
	if (json !== null && typeof json === "object" && !Array.isArray(json)) {
		const fm = (json as Record<string, unknown>).frontmatter;
		if (fm !== null && typeof fm === "object" && !Array.isArray(fm)) {
			const override = readAutoPlanRunAgent(fm as Record<string, unknown>);
			if (override !== undefined) return override;
		}
	}
	return run.agentName;
}

export function parsePlanIds(body: string): Set<string> {
	const ids = new Set<string>();
	for (const line of splitLines(body)) {
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const id = (raw as Record<string, unknown>).id;
			if (typeof id === "string" && id.length > 0) ids.add(id);
		} catch {
			// skip unparseable lines
		}
	}
	return ids;
}

export function parsePlanChildren(body: string, planId: string): string[] {
	for (const line of splitLines(body)) {
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
			const obj = raw as Record<string, unknown>;
			if (obj.id !== planId) continue;
			const children = obj.children;
			if (!Array.isArray(children)) return [];
			return children.filter((c): c is string => typeof c === "string" && c.length > 0);
		} catch {
			// skip unparseable lines
		}
	}
	return [];
}

export interface DispatchAutoPlanRunsInput {
	readonly run: {
		id: string;
		plotId: string | null;
		renderedAgentJson: unknown;
		agentName: string;
	};
	readonly project: { id: string; defaultBranch: string; localPath: string };
	readonly workspacePlanIds: Set<string> | null;
	readonly baselinePlanIds: Set<string> | null;
	readonly workspacePlansBody: string | null;
	readonly planRuns: { create: (input: unknown) => Promise<{ planRun: { id: string } }> };
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "auto_plan_run", err: unknown) => Promise<void>;
	/**
	 * Optional seeds-CLI seam (warren-41d5). When wired, every child seed of
	 * a new plan is probed via `showSeed` before the plan-run is created —
	 * mirroring the manual `POST /plan-runs` handler's validation. A plan
	 * referencing a seed that doesn't resolve (or whose children are all
	 * closed) is skipped with an `auto_plan_run_skipped` event instead of
	 * being dispatched, so the coordinator never wedges on an unresolvable
	 * child. Absent (existing unit tests) ⇒ no validation, behavior
	 * unchanged — same optional-seam posture as `warrenConfigs`/`portAllocator`.
	 */
	readonly seedsCli?: SeedsCliDeps;
}

type PlanChildrenValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * Mirror the manual handler's child-seed validation (warren-41d5): probe
 * every child via `showSeed`. A `SeedNotFoundError` on any child marks the
 * plan un-dispatchable (`missing_child_seeds`); a plan whose children all
 * resolve but are all `closed` is rejected too (`all_children_closed`,
 * matching the manual handler's `hasOpenChild` gate). Transient `sd`
 * failures (timeout, lock) propagate so the caller surfaces them as a
 * `reap_failed` step=`auto_plan_run` event rather than silently skipping.
 */
async function validatePlanChildren(
	seedsCli: SeedsCliDeps,
	projectPath: string,
	children: readonly string[],
): Promise<PlanChildrenValidation> {
	const probes = await Promise.all(
		children.map(async (seedId) => {
			try {
				const issue = await showSeed(seedsCli, projectPath, seedId);
				return { status: issue.status, missing: false };
			} catch (err) {
				if (err instanceof SeedNotFoundError) return { seedId, status: null, missing: true };
				throw err;
			}
		}),
	);
	const missing = probes
		.filter((p): p is { seedId: string; status: null; missing: true } => p.missing)
		.map((p) => p.seedId);
	if (missing.length > 0) return { ok: false, reason: "missing_child_seeds", missing };
	if (!probes.some((p) => p.status !== "closed")) {
		return { ok: false, reason: "all_children_closed", missing: [] };
	}
	return { ok: true };
}

export interface DispatchAutoPlanRunsResult {
	readonly created: boolean;
	readonly id: string | null;
	readonly planId: string | null;
}

/**
 * Dispatch a single new plan: parse its children, validate them against the
 * persisted seed store when `seedsCli` is wired (warren-41d5), and create the
 * plan-run. Returns the new plan-run id on dispatch, or `null` when the plan
 * was skipped (no children, missing/closed child seeds — the latter emit an
 * `auto_plan_run_skipped` event). Throws on a transient failure so the caller
 * surfaces it as `reap_failed` step=`auto_plan_run`.
 */
async function dispatchOnePlan(
	input: DispatchAutoPlanRunsInput,
	planId: string,
	workspacePlansBody: string,
): Promise<string | null> {
	const children = parsePlanChildren(workspacePlansBody, planId);
	if (children.length === 0) return null;
	if (input.seedsCli !== undefined) {
		const validation = await validatePlanChildren(
			input.seedsCli,
			input.project.localPath,
			children,
		);
		if (!validation.ok) {
			await input.emit("auto_plan_run_skipped", {
				planId,
				reason: validation.reason,
				missing: validation.missing,
			});
			return null;
		}
	}
	const result = await input.planRuns.create({
		planId,
		projectId: input.project.id,
		agentName: resolveAutoPlanRunAgent(input.run),
		children: children.map((seedId, i) => ({ seq: i + 1, seedId })),
		trigger: "auto_plan_run",
		ref: input.project.defaultBranch,
		parentRunId: input.run.id,
		...(input.run.plotId !== null ? { plotId: input.run.plotId } : {}),
	});
	await input.emit("auto_plan_run_created", {
		planId,
		planRunId: result.planRun.id,
		childCount: children.length,
	});
	return result.planRun.id;
}

/**
 * Auto-dispatch plan-runs for plans the agent created during this run
 * (warren-a32a). Returns the last-created plan-run's ids so reap can
 * surface them on the result. Best-effort: per-plan failures emit
 * `reap_failed` step=`auto_plan_run` and continue.
 */
export async function dispatchAutoPlanRuns(
	input: DispatchAutoPlanRunsInput,
): Promise<DispatchAutoPlanRunsResult> {
	const { workspacePlanIds, baselinePlanIds, workspacePlansBody } = input;
	if (workspacePlanIds === null || baselinePlanIds === null || workspacePlansBody === null) {
		return { created: false, id: null, planId: null };
	}
	let created = false;
	let id: string | null = null;
	let planIdOut: string | null = null;
	// Detect new plans by ID, not set size: a plan replaced during the run
	// (one closed + one created) leaves the count unchanged, so a size-based
	// early-exit would drop the genuinely new plan (warren-c40e).
	for (const planId of workspacePlanIds) {
		if (baselinePlanIds.has(planId)) continue;
		try {
			const planRunId = await dispatchOnePlan(input, planId, workspacePlansBody);
			if (planRunId !== null) {
				created = true;
				id = planRunId;
				planIdOut = planId;
			}
		} catch (err) {
			await input.fail("auto_plan_run", err);
		}
	}
	return { created, id, planId: planIdOut };
}
