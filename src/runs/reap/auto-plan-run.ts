import { readAutoPlanRunAgent } from "../../registry/schema.ts";
import { splitLines } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Auto plan-run detection (warren-a32a)                                    */
/* ----------------------------------------------------------------------- */

export function hasAutoPlanRunFrontmatter(run: { renderedAgentJson: unknown }): boolean {
	const json = run.renderedAgentJson;
	if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
	const fm = (json as Record<string, unknown>).frontmatter;
	if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return false;
	return (fm as Record<string, unknown>).auto_plan_run === true;
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
	readonly project: { id: string; defaultBranch: string };
	readonly workspacePlanIds: Set<string> | null;
	readonly baselinePlanIds: Set<string> | null;
	readonly workspacePlansBody: string | null;
	readonly planRuns: { create: (input: unknown) => Promise<{ planRun: { id: string } }> };
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "auto_plan_run", err: unknown) => Promise<void>;
}

export interface DispatchAutoPlanRunsResult {
	readonly created: boolean;
	readonly id: string | null;
	readonly planId: string | null;
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
	if (
		workspacePlanIds === null ||
		baselinePlanIds === null ||
		workspacePlansBody === null ||
		workspacePlanIds.size <= baselinePlanIds.size
	) {
		return { created: false, id: null, planId: null };
	}
	const newPlanIds: string[] = [];
	for (const id of workspacePlanIds) {
		if (!baselinePlanIds.has(id)) newPlanIds.push(id);
	}
	let created = false;
	let id: string | null = null;
	let planIdOut: string | null = null;
	for (const planId of newPlanIds) {
		try {
			const children = parsePlanChildren(workspacePlansBody, planId);
			if (children.length === 0) continue;
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
			created = true;
			id = result.planRun.id;
			planIdOut = planId;
			await input.emit("auto_plan_run_created", {
				planId,
				planRunId: result.planRun.id,
				childCount: children.length,
			});
		} catch (err) {
			await input.fail("auto_plan_run", err);
		}
	}
	return { created, id, planId: planIdOut };
}
