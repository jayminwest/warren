/** Repository for the `runs` table (queued → running → terminal). */

import { and, eq } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type {
	CloneKind,
	PullRequestLifecycle,
	RunCostBasis,
	RunFailureReason,
	RunMode,
	RunRow,
	RunState,
	RunTerminalState,
} from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
import { fixAttemptHistoryByPrUrl, listPrCandidatesByProject } from "./runs-ci-fixer.ts";
import { deleteNeverStarted } from "./runs-delete.ts";
import {
	type RunOutcomeFacts,
	setOutcomeFacts as setOutcomeFactsBody,
} from "./runs-outcome-facts.ts";
import { setBranch, setPrState, setPrUrl } from "./runs-pr.ts";
import { type AttachPreviewInput, attachPreview } from "./runs-preview.ts";
import {
	aggregate,
	findByRetryOf,
	listAll,
	listByAgent,
	listByIds,
	listByProject,
	listByState,
	listForAnalytics,
	listWithUnresolvedPr,
} from "./runs-queries.ts";
import { countNonTerminal } from "./runs-stats.ts";
import { clearBurrowIdForWorkspace } from "./runs-workspace.ts";

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

// Preview-transition guard + input shape live in runs-preview.ts (file-size
// split); re-exported here so existing import sites keep working.
export { type AttachPreviewInput, assertPreviewTransition } from "./runs-preview.ts";

export interface CreateRunInput {
	id?: string;
	agentName: string;
	projectId: string;
	prompt: string;
	renderedAgentJson: unknown;
	trigger: string;
	sandboxId?: string | null;
	sandboxRunId?: string | null;
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
	/** Continuation/replicate back-link (warren-4b11 / warren-e96f); null for root runs. */
	parentRunId?: string | null;
	/** Infra-lost auto-retry back-link (warren-4af7); null for first attempts. */
	retryOf?: string | null;
	/** Chain kind (warren-e96f); null for root runs. */
	cloneKind?: CloneKind | null;
	/** Operator-requested target branch (warren-1f81, #419); null = none. */
	targetBranch?: string | null;
	/** Dispatch-supplied git ref the workspace clones from (warren-afeb); null = none. */
	ref?: string | null;
	/** Base-commit pin (warren-aaf7): 40-hex SHA the workspace is cut at; null = none. */
	baseCommit?: string | null;
	/** Declared provider/model frozen at dispatch (warren-2ede / pl-103e).
	 * Null = agent declares none (or a historical row). */
	provider?: string | null;
	model?: string | null;
	/** Cost basis (warren-f3c3); defaults to `api`. */
	costBasis?: RunCostBasis;
	/** Queued-instant override (warren-0af9); defaults to the wall clock at insert. */
	now?: Date;
}

export interface AttachBurrowInput {
	sandboxId?: string;
	sandboxRunId?: string;
	workerId?: string;
}

export interface AttachStatsInput {
	costUsd?: number | null;
	tokensInput?: number | null;
	tokensOutput?: number | null;
	tokensCacheRead?: number | null;
	tokensCacheWrite?: number | null;
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
		const { costBasis = "api" } = input;
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			agentName: input.agentName,
			projectId: input.projectId,
			sandboxId: input.sandboxId ?? null,
			sandboxRunId: input.sandboxRunId ?? null,
			workerId: input.workerId ?? null,
			seedId: input.seedId ?? null,
			parentRunId: input.parentRunId ?? null,
			cloneKind: input.cloneKind ?? null,
			retryOf: input.retryOf ?? null,
			renderedAgentJson: input.renderedAgentJson,
			state: "queued",
			failureReason: null,
			// The queued instant (warren-0af9), stamped at insert; queue wait is
			// `startedAt - createdAt`.
			createdAt: (input.now ?? new Date()).getTime(),
			startedAt: null,
			endedAt: null,
			prompt: input.prompt,
			trigger: input.trigger,
			prUrl: null,
			targetBranch: input.targetBranch ?? null,
			branch: null,
			ref: input.ref ?? null,
			baseCommit: input.baseCommit ?? null,
			provider: input.provider ?? null,
			model: input.model ?? null,
			// Merge-watcher facts (warren-3bc6): unset until post_reap settles the PR.
			prState: null,
			prMergedAt: null,
			// Outcome facts (warren-ab2b): unknown until reap measures them — NULL.
			commitsAhead: null,
			filesChanged: null,
			insertions: null,
			deletions: null,
			salvageRef: null,
			salvagePath: null,
			costUsd: null,
			costBasis,
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

	/** Hard-delete a never-started run row (warren-a0a2); body in runs-delete.ts. */
	deleteNeverStarted(id: string): Promise<boolean> {
		return deleteNeverStarted(this.adapter, id);
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

	/** Non-terminal (`queued`+`running`) count; body in runs-stats.ts (warren-e1f1). */
	countNonTerminal(projectId?: string): Promise<number> {
		return countNonTerminal(this.adapter, projectId);
	}

	/** The retry a `sandbox_run_lost` original spawned (warren-4af7); body in runs-queries.ts. */
	findByRetryOf(runId: string): Promise<RunRow | null> {
		return findByRetryOf(this.adapter, runId);
	}

	/** Write back sandbox IDs as spawn provisions them; at least one field required. */
	async attachBurrow(id: string, input: AttachBurrowInput): Promise<RunRow> {
		if (
			input.sandboxId === undefined &&
			input.sandboxRunId === undefined &&
			input.workerId === undefined
		) {
			throw new ValidationError(
				"attachBurrow requires at least one of sandboxId, sandboxRunId, or workerId",
			);
		}
		const current = await this.require(id);
		const patch: { sandboxId?: string; sandboxRunId?: string; workerId?: string } = {};
		if (input.sandboxId !== undefined) patch.sandboxId = input.sandboxId;
		if (input.sandboxRunId !== undefined) patch.sandboxRunId = input.sandboxRunId;
		if (input.workerId !== undefined) patch.workerId = input.workerId;
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/** Null sandboxId after workspace destroy (warren-9b77); body in runs-workspace.ts. */
	clearBurrowIdForWorkspace(sandboxId: string): Promise<void> {
		return clearBurrowIdForWorkspace(this.adapter, sandboxId);
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
	 * Narrow write-through for the usage hydrator (warren-b33e): persist
	 * derived cost/token totals onto the run row wholesale (no partial
	 * patch semantics — the caller always has a full aggregate). Leaves
	 * `cost_basis` and every other column untouched.
	 */
	async updateUsage(
		id: string,
		stats: {
			costUsd: number;
			tokensInput: number;
			tokensOutput: number;
			tokensCacheRead: number;
			tokensCacheWrite: number;
		},
	): Promise<void> {
		await this.adapter.runWrite(this.db.update(this.runs).set(stats).where(eq(this.runs.id, id)));
	}

	/** Preview-environment write (R-19); body lives in runs-preview.ts. */
	attachPreview(id: string, input: AttachPreviewInput): Promise<RunRow> {
		return attachPreview(this.adapter, id, input);
	}

	/** PR-fact writes (warren-f6af / warren-3bc6); bodies live in runs-pr.ts. */
	setPrUrl(id: string, prUrl: string | null): Promise<RunRow> {
		return setPrUrl(this.adapter, id, prUrl);
	}

	/** Branch-fact write (warren-5255); body lives in runs-pr.ts. */
	setBranch(id: string, branch: string): Promise<RunRow> {
		return setBranch(this.adapter, id, branch);
	}

	setPrState(
		id: string,
		prState: PullRequestLifecycle,
		prMergedAt: string | null,
	): Promise<RunRow> {
		return setPrState(this.adapter, id, prState, prMergedAt);
	}

	/**
	 * Runs whose PR the merge watcher still has to settle (warren-3bc6):
	 * `pr_url` set and `pr_state` NULL or `open`. Boot re-adoption
	 * enumerates these so a restart never orphans an in-flight poll.
	 */
	listWithUnresolvedPr(): Promise<RunRow[]> {
		return listWithUnresolvedPr(this.adapter);
	}

	/**
	 * Persist where a failed finalize's work was salvaged to (warren-cd3b):
	 * the rescue branch on origin (`salvageRef`) and/or the durable git-bundle
	 * file (`salvagePath`). Last write wins.
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

	/**
	 * Persist the reap-time outcome facts (warren-ab2b / pl-103e). Last
	 * write wins; NULL means unknown, never zero. Body lives in
	 * runs-outcome-facts.ts (file-size budget).
	 */
	async setOutcomeFacts(id: string, facts: RunOutcomeFacts): Promise<RunRow> {
		return setOutcomeFactsBody(this.adapter, id, facts);
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
