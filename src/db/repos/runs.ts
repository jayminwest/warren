/**
 * Repository for the `runs` table.
 *
 * Warren's run row mirrors the lifecycle of the underlying burrow run
 * (queued → running → succeeded|failed|cancelled). The state is updated as
 * we observe burrow's stream; warren itself does not pick runs off a queue.
 *
 * `attachBurrow` exists because the §4.3 composition flow creates the warren
 * row before burrow's `POST /burrows` and `POST /burrows/:id/runs` return —
 * the burrow IDs are written back once we have them.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type {
	CloneKind,
	PreviewState,
	RunFailureReason,
	RunMode,
	RunRow,
	RunState,
	RunTerminalState,
} from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
import { fixAttemptHistoryByPrUrl, listPrCandidatesByProject } from "./runs-ci-fixer.ts";
import {
	aggregate,
	listAll,
	listByAgent,
	listByIds,
	listByPlotId,
	listByProject,
	listByState,
	listForAnalytics,
} from "./runs-queries.ts";

const ALLOWED_TRANSITIONS: Record<RunState, readonly RunState[]> = {
	queued: ["running", "cancelled"],
	// `paused` is pl-0344 step 1 / warren-67b6: the supervisor (step 5 /
	// warren-2976) flips a running batch run to `paused` on detection of a
	// blocking Plot `question_posed` event; the answer (or pause-timeout)
	// flips it back to `running` via a respawned turn. Operators can still
	// cancel a paused run.
	running: ["paused", "succeeded", "failed", "cancelled"],
	paused: ["running", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new StateTransitionError(`invalid run transition: ${from} → ${to}`);
	}
}

export interface CreateRunInput {
	id?: string;
	agentName: string;
	projectId: string;
	prompt: string;
	renderedAgentJson: unknown;
	trigger: string;
	burrowId?: string | null;
	burrowRunId?: string | null;
	/** Worker hosting the burrow (warren-135b); denormalized for run routing. */
	workerId?: string | null;
	/** Seeds issue back-link (pl-bb70 step 3); null = no seed. */
	seedId?: string | null;
	/**
	 * Run mode (pl-0344 step 1 / warren-67b6). `batch` (default) is the
	 * historical single-shot run; `interactive` is the respawn-per-turn
	 * primitive (warren-1117). Fixed at run-create time.
	 */
	mode?: RunMode;
	/**
	 * Back-link to the Plot this run was dispatched against (warren-a8c3).
	 * Null when the project hasn't opted into Plots or plot_id was omitted;
	 * `project.hasPlot` is validated at the handler.
	 */
	plotId?: string | null;
	/**
	 * Continuation/replicate back-link (warren-4b11 / warren-e96f). Null for
	 * root runs; plain text id, no FK. `cloneKind` tells the two chain kinds
	 * apart: `continue` (seed from parent's pushed branch) vs `replicate`.
	 */
	parentRunId?: string | null;
	/** Chain kind (warren-e96f); null for root runs. */
	cloneKind?: CloneKind | null;
	/**
	 * Operator-requested target branch the run was dispatched against
	 * (warren-1f81, #419). Null/omitted = no explicit target branch.
	 */
	targetBranch?: string | null;
	now?: Date;
}

export interface AttachBurrowInput {
	burrowId?: string;
	burrowRunId?: string;
	workerId?: string;
}

export interface AttachStatsInput {
	costUsd?: number | null;
	tokensInput?: number | null;
	tokensOutput?: number | null;
	tokensCacheRead?: number | null;
	tokensCacheWrite?: number | null;
}

export interface AttachPreviewInput {
	previewState?: PreviewState | null;
	previewPort?: number | null;
	previewStartedAt?: string | null;
	previewLastHitAt?: string | null;
	previewFailureMessage?: string | null;
}

export class RunsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get runs() {
		return this.adapter.schema.runs;
	}

	async create(input: CreateRunInput): Promise<RunRow> {
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			agentName: input.agentName,
			projectId: input.projectId,
			burrowId: input.burrowId ?? null,
			burrowRunId: input.burrowRunId ?? null,
			workerId: input.workerId ?? null,
			seedId: input.seedId ?? null,
			plotId: input.plotId ?? null,
			parentRunId: input.parentRunId ?? null,
			cloneKind: input.cloneKind ?? null,
			renderedAgentJson: input.renderedAgentJson,
			state: "queued",
			failureReason: null,
			startedAt: null,
			endedAt: null,
			prompt: input.prompt,
			trigger: input.trigger,
			prUrl: null,
			targetBranch: input.targetBranch ?? null,
			costUsd: null,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
			tokensCacheWrite: null,
			previewState: null,
			previewPort: null,
			previewStartedAt: null,
			previewLastHitAt: null,
			previewFailureMessage: null,
			mode: input.mode ?? "batch",
			pausedAt: null,
			pausedQuestionEventId: null,
		};
		await this.adapter.runWrite(this.db.insert(this.runs).values(row));
		return row;
	}

	async get(id: string): Promise<RunRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.runs).where(eq(this.runs.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<RunRow> {
		const row = await this.get(id);
		if (!row) throw new NotFoundError(`run not found: ${id}`);
		return row;
	}

	/** Read/query methods (warren-ac7f); bodies live in runs-queries.ts. */
	listAll(
		options: {
			limit?: number;
			offset?: number;
			sort?: "started" | "cost";
			dir?: "asc" | "desc";
		} = {},
	): Promise<RunRow[]> {
		return listAll(this.adapter, options);
	}

	listByProject(
		projectId: string,
		options: {
			limit?: number;
			offset?: number;
			sort?: "started" | "cost";
			dir?: "asc" | "desc";
		} = {},
	): Promise<RunRow[]> {
		return listByProject(this.adapter, projectId, options);
	}

	listByPlotId(plotId: string): Promise<RunRow[]> {
		return listByPlotId(this.adapter, plotId);
	}

	listByAgent(
		agentName: string,
		options: {
			limit?: number;
			offset?: number;
			sort?: "started" | "cost";
			dir?: "asc" | "desc";
		} = {},
	): Promise<RunRow[]> {
		return listByAgent(this.adapter, agentName, options);
	}

	aggregate(filter: { projectId?: string; agentName?: string } = {}): Promise<{
		total: number;
		costTotalUsd: number;
		costPricedCount: number;
	}> {
		return aggregate(this.adapter, filter);
	}

	listForAnalytics(
		filter: { projectId?: string; from?: string; to?: string } = {},
	): Promise<RunRow[]> {
		return listForAnalytics(this.adapter, filter);
	}

	listByIds(ids: readonly string[]): Promise<RunRow[]> {
		return listByIds(this.adapter, ids);
	}

	listByState(state: RunState | RunState[]): Promise<RunRow[]> {
		return listByState(this.adapter, state);
	}

	/**
	 * Write back the burrow IDs as they become available. The §4.3 spawn flow
	 * provisions the burrow first (`POST /burrows`) and dispatches the run
	 * second (`POST /burrows/:id/runs`), so each ID lands on a different turn.
	 * Both fields are optional, but at least one must be set.
	 */
	async attachBurrow(id: string, input: AttachBurrowInput): Promise<RunRow> {
		if (
			input.burrowId === undefined &&
			input.burrowRunId === undefined &&
			input.workerId === undefined
		) {
			throw new ValidationError(
				"attachBurrow requires at least one of burrowId, burrowRunId, or workerId",
			);
		}
		const current = await this.require(id);
		const patch: { burrowId?: string; burrowRunId?: string; workerId?: string } = {};
		if (input.burrowId !== undefined) patch.burrowId = input.burrowId;
		if (input.burrowRunId !== undefined) patch.burrowRunId = input.burrowRunId;
		if (input.workerId !== undefined) patch.workerId = input.workerId;
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	async markRunning(id: string, now: Date = new Date()): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, "running");
		const patch = {
			state: "running" as const,
			startedAt: now.toISOString(),
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Transition `running → paused` for the pause detector (pl-0344 step 5
	 * / warren-2976). Stamps `paused_at` + `paused_question_event_id`; the
	 * resume path (`markResumedFromPause`) clears both on transition back
	 * to `running`. `failureReason` / `startedAt` / `endedAt` are
	 * intentionally left alone — a paused run isn't terminal, and the
	 * underlying burrow run continues to count against `startedAt`.
	 */
	async markPaused(id: string, questionEventId: string, now: Date = new Date()): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, "paused");
		const patch = {
			state: "paused" as const,
			pausedAt: now.toISOString(),
			pausedQuestionEventId: questionEventId,
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Transition `paused → running` for the pause detector resume path
	 * (pl-0344 step 5 / warren-2976). Clears `paused_at` +
	 * `paused_question_event_id` so a subsequent pause-detect pass against
	 * the same row reads as a fresh `running` row, not a stale paused
	 * remnant. Leaves `startedAt` alone — the burrow run's wall-clock
	 * lifetime is unchanged by a pause round-trip.
	 */
	async markResumedFromPause(id: string): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, "running");
		const patch = {
			state: "running" as const,
			pausedAt: null,
			pausedQuestionEventId: null,
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	async finalize(
		id: string,
		terminal: RunTerminalState,
		now: Date = new Date(),
		failureReason: RunFailureReason | null = null,
	): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, terminal);
		const patch = {
			state: terminal,
			endedAt: now.toISOString(),
			failureReason: terminal === "failed" ? failureReason : null,
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Persist per-run cost + token accounting (warren-a7dc). All fields are
	 * optional patches — omitted fields preserve the existing value, explicit
	 * `null` clears it. Mirrors `attachBurrow`'s partial-input semantics so the
	 * bridge can land start-snapshot and end-snapshot writes on different turns
	 * without juggling intermediate state. Throws ValidationError if no fields
	 * were supplied, matching `attachBurrow`. The columns are nullable so
	 * non-pi runs (or pi runs whose stats RPC failed) leave them at null.
	 */
	async attachStats(id: string, input: AttachStatsInput): Promise<RunRow> {
		const keys: (keyof AttachStatsInput)[] = [
			"costUsd",
			"tokensInput",
			"tokensOutput",
			"tokensCacheRead",
			"tokensCacheWrite",
		];
		if (keys.every((k) => input[k] === undefined)) {
			throw new ValidationError("attachStats requires at least one stat field");
		}
		const current = await this.require(id);
		const patch: Partial<RunRow> = {};
		for (const k of keys) {
			if (input[k] !== undefined) {
				(patch as Record<string, number | null>)[k] = input[k] as number | null;
			}
		}
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Persist per-run preview environment fields (R-19 / SPEC §11.L). Mirrors
	 * `attachStats`'s partial-input semantics (mx-49272e): omitted fields
	 * preserve existing values, explicit `null` clears. Throws ValidationError
	 * when called with no fields, matching `attachBurrow` / `attachStats`.
	 * Used by reap's `preview_launch` sub-step, the readiness probe, the host
	 * reverse proxy (debounced `previewLastHitAt`), the eviction worker, and
	 * the manual teardown route.
	 */
	async attachPreview(id: string, input: AttachPreviewInput): Promise<RunRow> {
		const keys: (keyof AttachPreviewInput)[] = [
			"previewState",
			"previewPort",
			"previewStartedAt",
			"previewLastHitAt",
			"previewFailureMessage",
		];
		if (keys.every((k) => input[k] === undefined)) {
			throw new ValidationError("attachPreview requires at least one preview field");
		}
		const current = await this.require(id);
		const patch: Partial<RunRow> = {};
		for (const k of keys) {
			if (input[k] !== undefined) {
				(patch as Record<string, unknown>)[k] = input[k];
			}
		}
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Persist the PR URL reap's `pr_open` sub-step opened (warren-f6af).
	 * Last write wins; passing `null` clears the field. Separate from
	 * `finalize` because reap fires this *before* the terminal transition
	 * (so the URL lands on the `reap.completed` event payload too).
	 */
	async setPrUrl(id: string, prUrl: string | null): Promise<RunRow> {
		const current = await this.require(id);
		await this.adapter.runWrite(
			this.db.update(this.runs).set({ prUrl }).where(eq(this.runs.id, id)),
		);
		return { ...current, prUrl };
	}

	/**
	 * Project-affinity probe for `placeFor` (warren-135b / pl-9ba1 step 2):
	 * the most-recent run that succeeded against this project AND has a
	 * recorded `workerId`. Returns null if the project has no successful
	 * runs yet, or if no successful run was tagged with a worker (rows
	 * written before pl-9ba1 step 4 wired this in). Newest-first by
	 * `endedAt` so a recent run wins over an older one even if the older
	 * one started later in startedAt order.
	 */
	async mostRecentSucceededWithWorker(projectId: string): Promise<RunRow | null> {
		const row = await this.adapter.pickOne(
			this.db
				.select()
				.from(this.runs)
				.where(
					and(
						eq(this.runs.projectId, projectId),
						eq(this.runs.state, "succeeded"),
						isNotNull(this.runs.workerId),
					),
				)
				.orderBy(desc(this.runs.endedAt), asc(this.runs.id))
				.limit(1),
		);
		return row ?? null;
	}

	/**
	 * In-flight load per worker for the least-loaded leg of `placeFor`
	 * (warren-135b / pl-9ba1 step 2). Counts `queued` + `running` runs
	 * grouped by `workerId`. Rows with a null `workerId` (legacy or
	 * unplaced) are excluded. Result is keyed by worker name; workers
	 * with zero in-flight runs are absent (the caller defaults to 0).
	 */
	async countInflightByWorker(): Promise<Map<string, number>> {
		const rows = await this.adapter.pickAll<{ workerId: string | null; count: number | string }>(
			this.db
				.select({
					workerId: this.runs.workerId,
					count: sql<number>`count(*)`.as("count"),
				})
				.from(this.runs)
				.where(and(isNotNull(this.runs.workerId), inArray(this.runs.state, ["queued", "running"])))
				.groupBy(this.runs.workerId),
		);
		const out = new Map<string, number>();
		for (const r of rows) {
			if (r.workerId !== null) out.set(r.workerId, Number(r.count));
		}
		return out;
	}

	/** CI-fixer queries (warren-0b75); bodies live in runs-ci-fixer.ts. */
	listPrCandidatesByProject(projectId: string, limit = 25) {
		return listPrCandidatesByProject(this.adapter, projectId, limit);
	}

	fixAttemptHistoryByPrUrl(prUrl: string) {
		return fixAttemptHistoryByPrUrl(this.adapter, prUrl);
	}

	/**
	 * Atomic queued → running transition. Returns the claimed row, or null
	 * if the row no longer exists or is no longer in `queued`. Used to keep
	 * the warren-side state in sync with burrow's "the run loop just picked
	 * this up" observation.
	 */
	async claimById(id: string, now: Date = new Date()): Promise<RunRow | null> {
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const runs = tx.schema.runs;
			const row = await tx.pickOne(txDb.select().from(runs).where(eq(runs.id, id)));
			if (!row || row.state !== "queued") return null;
			const startedAt = now.toISOString();
			await tx.runWrite(
				txDb
					.update(runs)
					.set({ state: "running", startedAt })
					.where(and(eq(runs.id, id), eq(runs.state, "queued"))),
			);
			return { ...row, state: "running", startedAt };
		});
	}
}
