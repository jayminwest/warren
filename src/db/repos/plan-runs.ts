/**
 * Repository for the `plan_runs` + `plan_run_children` tables
 * (pl-a258 step 2 / warren-4d7c).
 *
 * `POST /plan-runs` inserts one parent row plus one child row per step in
 * the seeds plan. The coordinator (warren-2623) walks
 * `plan_run_children.seq` in order: pick the lowest-seq pending child,
 * spawn a warren run, wait for it to merge, advance. Atomicity matters at
 * insert time — children without a parent (or a parent missing children)
 * would leave the queue in a state the tick loop can't recover from —
 * which is why `create` lands both writes in a single transaction (mx-d5cf19
 * sqlite-async-tx pattern; pg uses drizzle's native tx).
 *
 * State machine for `plan_runs` (mirrors RunsRepo per mx-a5432a):
 *
 *   queued    → running, cancelled
 *   running   → succeeded, failed, cancelled
 *   succeeded → ø    failed → ø    cancelled → ø
 *
 * Child state transitions are NOT guarded here — the coordinator's
 * decision tree is the source of truth for which advance is legal at any
 * given moment, and the repo's job is to persist that decision. The repo
 * merely refuses to write a child patch against a non-existent
 * (planRunId, seq) pair (require-style read first).
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { PlanRunChildRow, PlanRunChildState, PlanRunRow, PlanRunState } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

const ALLOWED_TRANSITIONS: Record<PlanRunState, readonly PlanRunState[]> = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

export function assertPlanRunTransition(from: PlanRunState, to: PlanRunState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new StateTransitionError(`invalid plan_run transition: ${from} → ${to}`);
	}
}

export interface CreatePlanRunChildInput {
	seq: number;
	seedId: string;
	state?: PlanRunChildState;
}

export interface CreatePlanRunInput {
	id?: string;
	planId: string;
	projectId: string;
	agentName: string;
	promptTemplate?: string;
	ref?: string | null;
	providerOverride?: string | null;
	modelOverride?: string | null;
	dispatcherHandle?: string;
	trigger?: string;
	/**
	 * Back-link to the Plot this plan-run was dispatched against
	 * (warren-06dc / pl-7937 Phase 2). Null/undefined when the project
	 * hasn't opted into Plots or the dispatch omitted plot_id. Validation
	 * that the project actually has a `.plot/` directory happens at handler
	 * level via `project.hasPlot` — the repo writes whatever it's handed.
	 */
	plotId?: string | null;
	state?: PlanRunState;
	children: CreatePlanRunChildInput[];
	now?: Date;
}

export interface CreatePlanRunResult {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
}

export interface TransitionPlanRunOptions {
	failureReason?: string | null;
	startedAt?: string | null;
	endedAt?: string | null;
}

export interface UpdateChildInput {
	planRunId: string;
	seq: number;
	patch: PlanRunChildPatch;
	now?: Date;
}

export interface PlanRunChildPatch {
	runId?: string | null;
	state?: PlanRunChildState;
	startedAt?: string | null;
	endedAt?: string | null;
	prMergedAt?: string | null;
	failureReason?: string | null;
}

const CHILD_PATCH_KEYS = [
	"runId",
	"state",
	"startedAt",
	"endedAt",
	"prMergedAt",
	"failureReason",
] as const satisfies readonly (keyof PlanRunChildPatch)[];

export class PlanRunsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get planRuns() {
		return this.adapter.schema.planRuns;
	}

	private get planRunChildren() {
		return this.adapter.schema.planRunChildren;
	}

	/**
	 * Land the parent + N children in a single transaction. Duplicate `seq`
	 * within `input.children` is caught by the composite PK at insert time
	 * (sqlite raises SQLITE_CONSTRAINT, pg raises a unique-violation); the
	 * transaction rolls back so the parent row never appears without its
	 * full child set.
	 */
	async create(input: CreatePlanRunInput): Promise<CreatePlanRunResult> {
		if (input.children.length === 0) {
			throw new ValidationError("plan_runs.create requires at least one child");
		}
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = input.id ?? generateId("planRun");
		const planRunRow: PlanRunRow = {
			id,
			planId: input.planId,
			projectId: input.projectId,
			agentName: input.agentName,
			promptTemplate: input.promptTemplate ?? "work on sd {seed_id}",
			ref: input.ref ?? null,
			providerOverride: input.providerOverride ?? null,
			modelOverride: input.modelOverride ?? null,
			dispatcherHandle: input.dispatcherHandle ?? "operator",
			trigger: input.trigger ?? "manual",
			plotId: input.plotId ?? null,
			state: input.state ?? "queued",
			failureReason: null,
			createdAt: nowIso,
			startedAt: null,
			endedAt: null,
		};
		const childRows: PlanRunChildRow[] = input.children.map((c) => ({
			planRunId: id,
			seq: c.seq,
			seedId: c.seedId,
			runId: null,
			state: c.state ?? "pending",
			createdAt: nowIso,
			updatedAt: nowIso,
			startedAt: null,
			endedAt: null,
			prMergedAt: null,
			failureReason: null,
		}));
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			await tx.runWrite(txDb.insert(tx.schema.planRuns).values(planRunRow));
			for (const row of childRows) {
				await tx.runWrite(txDb.insert(tx.schema.planRunChildren).values(row));
			}
			return { planRun: planRunRow, children: childRows };
		});
	}

	async getById(id: string): Promise<PlanRunRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.planRuns).where(eq(this.planRuns.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<PlanRunRow> {
		const row = await this.getById(id);
		if (!row) throw new NotFoundError(`plan_run not found: ${id}`);
		return row;
	}

	/**
	 * For a set of `runs.id` values, return the `(runId, planId, planRunId)`
	 * tuple for those that were dispatched as children of a plan-run. Powers
	 * the cost analytics endpoint (warren-cf63 / pl-b0c0 step 6) which needs
	 * to attribute spend to a `planId` without an N+1 fanout. Runs that are
	 * not part of any plan-run are silently omitted; the caller treats them
	 * as `planId=null`.
	 */
	async resolvePlanForRunIds(
		runIds: readonly string[],
	): Promise<{ runId: string; planId: string; planRunId: string }[]> {
		if (runIds.length === 0) return [];
		const rows = await this.adapter.pickAll(
			this.db
				.select({
					runId: this.planRunChildren.runId,
					planRunId: this.planRunChildren.planRunId,
					planId: this.planRuns.planId,
				})
				.from(this.planRunChildren)
				.innerJoin(this.planRuns, eq(this.planRuns.id, this.planRunChildren.planRunId))
				.where(inArray(this.planRunChildren.runId, runIds as string[])),
		);
		const out: { runId: string; planId: string; planRunId: string }[] = [];
		for (const r of rows) {
			if (r.runId === null) continue;
			out.push({ runId: r.runId, planId: r.planId, planRunId: r.planRunId });
		}
		return out;
	}

	async listChildren(planRunId: string): Promise<PlanRunChildRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.planRunChildren)
				.where(eq(this.planRunChildren.planRunId, planRunId))
				.orderBy(asc(this.planRunChildren.seq)),
		);
	}

	async listByProjectAndState(
		projectId: string,
		state?: PlanRunState | PlanRunState[],
	): Promise<PlanRunRow[]> {
		const baseWhere = eq(this.planRuns.projectId, projectId);
		const where = state
			? and(
					baseWhere,
					Array.isArray(state)
						? inArray(this.planRuns.state, state)
						: eq(this.planRuns.state, state),
				)
			: baseWhere;
		return this.adapter.pickAll(
			this.db.select().from(this.planRuns).where(where).orderBy(asc(this.planRuns.createdAt)),
		);
	}

	/**
	 * Non-terminal plan_runs the coordinator should advance on each tick.
	 * Excludes `succeeded` / `failed` / `cancelled`. Ordered by createdAt so
	 * the tick walks them in insertion order — fairness without per-row
	 * scheduler bookkeeping.
	 */
	async listActive(): Promise<PlanRunRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.planRuns)
				.where(inArray(this.planRuns.state, ["queued", "running"]))
				.orderBy(asc(this.planRuns.createdAt)),
		);
	}

	/**
	 * Guarded plan_run state transition. Mirrors RunsRepo.markRunning /
	 * finalize (mx-a5432a) — the repo reads the current state, asserts the
	 * transition is allowed, and writes the patch in one pass. Optional
	 * `failureReason` / `startedAt` / `endedAt` patch the row alongside the
	 * state. Throws StateTransitionError on an illegal advance.
	 */
	async transitionTo(
		id: string,
		state: PlanRunState,
		opts: TransitionPlanRunOptions = {},
	): Promise<PlanRunRow> {
		const current = await this.require(id);
		assertPlanRunTransition(current.state, state);
		const patch: Partial<PlanRunRow> = { state };
		if (opts.startedAt !== undefined) patch.startedAt = opts.startedAt;
		if (opts.endedAt !== undefined) patch.endedAt = opts.endedAt;
		if (opts.failureReason !== undefined) patch.failureReason = opts.failureReason;
		await this.adapter.runWrite(
			this.db.update(this.planRuns).set(patch).where(eq(this.planRuns.id, id)),
		);
		return { ...current, ...patch };
	}

	/**
	 * Partial-input patch for a child row. Mirrors RunsRepo.attachBurrow
	 * (mx-0a7a65): omitted fields preserve their value, explicit `null`
	 * clears nullable fields. `updatedAt` is always bumped to `now` so the
	 * UI can sort by latest activity. Throws ValidationError when called
	 * with no fields and NotFoundError if the (planRunId, seq) pair is
	 * absent.
	 */
	async updateChild(input: UpdateChildInput): Promise<PlanRunChildRow> {
		if (CHILD_PATCH_KEYS.every((k) => input.patch[k] === undefined)) {
			throw new ValidationError("plan_runs.updateChild requires at least one patch field");
		}
		const current = await this.adapter.pickOne(
			this.db
				.select()
				.from(this.planRunChildren)
				.where(
					and(
						eq(this.planRunChildren.planRunId, input.planRunId),
						eq(this.planRunChildren.seq, input.seq),
					),
				),
		);
		if (!current) {
			throw new NotFoundError(
				`plan_run_child not found: planRunId=${input.planRunId} seq=${input.seq}`,
			);
		}
		const patch: Partial<PlanRunChildRow> = {
			updatedAt: (input.now ?? new Date()).toISOString(),
		};
		for (const k of CHILD_PATCH_KEYS) {
			if (input.patch[k] !== undefined) {
				(patch as Record<string, unknown>)[k] = input.patch[k];
			}
		}
		await this.adapter.runWrite(
			this.db
				.update(this.planRunChildren)
				.set(patch)
				.where(
					and(
						eq(this.planRunChildren.planRunId, input.planRunId),
						eq(this.planRunChildren.seq, input.seq),
					),
				),
		);
		return { ...current, ...patch };
	}

	/**
	 * Lowest-seq child still in `pending`. The coordinator calls this after
	 * confirming no in-flight child is blocking progress; null means the
	 * plan-run can transition to `succeeded` (every child reached a terminal
	 * state).
	 */
	async pickNextPending(planRunId: string): Promise<PlanRunChildRow | null> {
		const row = await this.adapter.pickOne(
			this.db
				.select()
				.from(this.planRunChildren)
				.where(
					and(
						eq(this.planRunChildren.planRunId, planRunId),
						eq(this.planRunChildren.state, "pending"),
					),
				)
				.orderBy(asc(this.planRunChildren.seq))
				.limit(1),
		);
		return row ?? null;
	}
}
