/**
 * Pure readiness computation for the ready-to-dispatch operator surface
 * (warren-6e2a / pl-3fc4 step 3).
 *
 * Given the set of plans (each with its child seed ids), a `seedId →
 * status` map, and the set of plan ids that already have a plan_run row,
 * decide which plans are "ready to dispatch": approved, still carrying at
 * least one open (non-closed) child seed, and not already dispatched.
 *
 * This module is intentionally side-effect-free so the HTTP handler
 * (warren-f716) can compose the seeds-cli readers + plan-runs dedup query
 * around it and unit-test the truth table in isolation.
 */

const APPROVED_STATUS = "approved";
const CLOSED_STATUS = "closed";

/** A plan as seen by the readiness computation. */
export interface ReadyPlanInput {
	id: string;
	name?: string;
	status: string;
	/** Child seed ids belonging to this plan. */
	children: string[];
}

/** A plan that surfaced as ready to dispatch. */
export interface ReadyPlan {
	id: string;
	name?: string;
	status: string;
	/** Number of child seeds that are still open (non-closed). */
	openChildCount: number;
}

export interface ComputeReadyPlansInput {
	plans: readonly ReadyPlanInput[];
	/** Status of every seed in the project, keyed by seed id. */
	seedStatusById: ReadonlyMap<string, string>;
	/** Plan ids that already have a plan_run row (deduped out). */
	dispatchedPlanIds: ReadonlySet<string>;
}

/**
 * Return the subset of `plans` that are ready to dispatch: status
 * `approved`, at least one open child seed, and not in
 * `dispatchedPlanIds`. Each surfaced plan is annotated with its
 * `openChildCount`.
 */
export function computeReadyPlans(input: ComputeReadyPlansInput): ReadyPlan[] {
	const { plans, seedStatusById, dispatchedPlanIds } = input;
	const ready: ReadyPlan[] = [];
	for (const plan of plans) {
		if (plan.status !== APPROVED_STATUS) continue;
		if (dispatchedPlanIds.has(plan.id)) continue;
		const openChildCount = countOpenChildren(plan.children, seedStatusById);
		if (openChildCount === 0) continue;
		ready.push({
			id: plan.id,
			...(plan.name === undefined ? {} : { name: plan.name }),
			status: plan.status,
			openChildCount,
		});
	}
	return ready;
}

/**
 * Count children that are open. A child is open unless its status is
 * exactly `closed`; unknown ids (absent from the map) are treated as open
 * so a plan never silently disappears due to a missing status row.
 */
function countOpenChildren(
	children: readonly string[],
	seedStatusById: ReadonlyMap<string, string>,
): number {
	let count = 0;
	for (const childId of children) {
		const status = seedStatusById.get(childId);
		if (status !== CLOSED_STATUS) count += 1;
	}
	return count;
}
