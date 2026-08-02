/**
 * Repository for the `runs` table.
 *
 * Warren's run row mirrors the lifecycle of the underlying burrow run
 * (queued → running → succeeded|failed|cancelled). The state is updated as
 * we observe burrow's stream; warren itself does not pick runs off a queue.
 *
 * `attachBurrow` exists because the composition flow (docs/design/agent-composition.md) creates the warren
 * row before burrow's `POST /burrows` and `POST /burrows/:id/runs` return —
 * the burrow IDs are written back once we have them.
 */

import { and, eq } from "drizzle-orm";
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
	listByProject,
	listByState,
	listForAnalytics,
} from "./runs-queries.ts";

const ALLOWED_TRANSITIONS: Record<RunState, readonly RunState[]> = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
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
			salvageRef: null,
			salvagePath: null,
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

	/**
	 * Hard-delete a run row that never reached the runtime (warren-a0a2).
	 *
	 * The scheduler's bounded-retry GC calls this to drop the transient
	 * `never_started` rows a persistently-unreachable runtime would otherwise
	 * mint one-per-tick, so the runs list isn't flooded during an outage. It
	 * is deliberately narrow:
	 *
	 *   - Guarded to `state=failed` + `failureReason=never_started`. Any other
	 *     row (a real queued/running/succeeded run, or a `failed` run that
	 *     actually dispatched) is left untouched and the method returns false.
	 *   - `events.run_id` carries no `ON DELETE` cascade, so the write-through
	 *     event rows are cleared first, then the run row, inside one
	 *     transaction. `triggers.last_run_id` / `plan_run_children.run_id`
	 *     (both `ON DELETE SET NULL`) and `run_inbox` (`CASCADE`) fall away on
	 *     their own; a never_started cron retry has none of them anyway.
	 *
	 * Returns true when a row was deleted, false when the id was missing or
	 * the guard rejected it.
	 */
	async deleteNeverStarted(id: string): Promise<boolean> {
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const runs = tx.schema.runs;
			const events = tx.schema.events;
			const existing = await tx.pickOne<RunRow>(txDb.select().from(runs).where(eq(runs.id, id)));
			if (!existing) return false;
			if (existing.state !== "failed" || existing.failureReason !== "never_started") {
				return false;
			}
			await tx.runWrite(txDb.delete(events).where(eq(events.runId, id)));
			await tx.runWrite(txDb.delete(runs).where(eq(runs.id, id)));
			return true;
		});
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
	 * Write back the burrow IDs as they become available. The spawn flow (docs/design/agent-composition.md)
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
	 * Persist per-run preview environment fields (R-19 / docs/design/preview-environments.md). Mirrors
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
	 * Persist where a failed finalize's work was salvaged to (warren-cd3b):
	 * the rescue branch on origin (`salvageRef`) and/or the durable git-bundle
	 * file (`salvagePath`). Written by the salvage intake handler (k8s) or
	 * reap's local salvage step before the workspace is destroyed. Last write
	 * wins (a retried/re-dispatched salvage overwrites the stale location).
	 */
	async setSalvage(
		id: string,
		salvage: { rescueRef: string | null; bundlePath: string | null },
	): Promise<RunRow> {
		const current = await this.require(id);
		await this.adapter.runWrite(
			this.db
				.update(this.runs)
				.set({ salvageRef: salvage.rescueRef, salvagePath: salvage.bundlePath })
				.where(eq(this.runs.id, id)),
		);
		return { ...current, salvageRef: salvage.rescueRef, salvagePath: salvage.bundlePath };
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
