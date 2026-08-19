/**
 * SeedsTracker — the seeds implementation of the IssueTracker contract
 * (warren-6c29, plan pl-a37b Track B step 1).
 *
 * Wraps the existing `src/seeds-cli/` facade 1:1 — no new shell-outs, no
 * changed envelope parsing:
 *
 *   - `getIssue`        ← `showSeed`        (incl. the stderr not-found
 *                        sniff, which lives in the facade's show.ts)
 *   - `listIssueStatuses` ← `listSeedStatuses`
 *   - `closeIssue`      ← `closeSeed`       (idempotent in seeds)
 *   - `listPlans`/`getPlan` ← `listPlans`/`showPlan`
 *   - `mergeIssueMetadata` ← `updateExtensions`
 *   - `listScheduledIssues` ← `listScheduledSeeds`
 *
 * All capabilities are true: seeds has plans, warren-namespaced metadata
 * writes, scheduled issues, and git-native storage (`.seeds/` in the
 * clone). Every facade `SeedsCliError` surfaces as a `TrackerError`
 * (missing ids as `IssueNotFoundError`), so contract consumers never
 * need to import the seeds error types.
 *
 * Additive in this PR: nothing calls this yet. ServerDeps swaps onto the
 * seam in warren-5819.
 */

import {
	type Issue,
	IssueNotFoundError,
	type IssueStatus,
	isPlanStatus,
	normalizeIssueStatus,
	PLAN_STATUSES,
	type Plan,
	type PlanSummary,
	type ScheduledIssue,
	type TrackerContext,
	TrackerError,
} from "../core/wire.ts";
import {
	closeSeed,
	listPlans,
	listScheduledSeeds,
	listSeedStatuses,
	type ParseScheduledSeedsResult,
	type PlanShowResult,
	SeedNotFoundError,
	type SeedShowResult,
	type SeedsCliDeps,
	SeedsCliError,
	showPlan,
	showSeed,
	updateExtensions,
	WarrenExtensionsSchema,
} from "../seeds-cli/index.ts";
import type {
	IssueTracker,
	MetadataCapableTracker,
	PlanCapableTracker,
	ScheduledIssueCapableTracker,
} from "./contract.ts";

/** The seeds extension-merge write is restricted to these keys (documented in warren-extensions.ts). */
const METADATA_RECOVERY_HINT =
	"seeds metadata writes are restricted to the warren-namespaced extension keys " +
	"(role, trigger, lastRunId, lastRunAt, scheduledFor, lastScheduledRun)";

export class SeedsTracker
	implements IssueTracker, PlanCapableTracker, MetadataCapableTracker, ScheduledIssueCapableTracker
{
	readonly capabilities = {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: true,
	} as const;

	constructor(private readonly deps: SeedsCliDeps) {}

	/**
	 * Seeds resolves `.seeds/` relative to cwd, so every operation needs
	 * the clone root. A hosted tracker would ignore `localPath`; here its
	 * absence is a programming error on the caller's side.
	 */
	private requireLocalPath(ctx: TrackerContext): string {
		if (ctx.localPath === undefined) {
			throw new TrackerError(
				`SeedsTracker requires TrackerContext.localPath for project ${ctx.projectId} ` +
					"(seeds resolves .seeds/ relative to cwd)",
			);
		}
		return ctx.localPath;
	}

	async getIssue(ctx: TrackerContext, issueId: string): Promise<Issue> {
		const localPath = this.requireLocalPath(ctx);
		let seed: SeedShowResult;
		try {
			seed = await showSeed(this.deps, localPath, issueId);
		} catch (err) {
			throw this.wrapError(err, `getIssue(${issueId})`);
		}
		const issue: Issue = {
			id: seed.id,
			status: normalizeIssueStatus(seed.status),
			...(seed.title !== undefined ? { title: seed.title } : {}),
			...(seed.description !== undefined ? { description: seed.description } : {}),
			...(seed.blockedBy !== undefined ? { blockedBy: seed.blockedBy } : {}),
			...(seed.extensions !== undefined ? { metadata: seed.extensions } : {}),
		};
		return issue;
	}

	async listIssueStatuses(ctx: TrackerContext): Promise<ReadonlyMap<string, IssueStatus>> {
		const localPath = this.requireLocalPath(ctx);
		let statuses: ReadonlyMap<string, string>;
		try {
			statuses = await listSeedStatuses(this.deps, localPath);
		} catch (err) {
			throw this.wrapError(err, "listIssueStatuses()");
		}
		const normalized = new Map<string, IssueStatus>();
		for (const [id, status] of statuses) {
			normalized.set(id, normalizeIssueStatus(status));
		}
		return normalized;
	}

	async closeIssue(ctx: TrackerContext, issueId: string): Promise<void> {
		const localPath = this.requireLocalPath(ctx);
		try {
			await closeSeed(this.deps, localPath, issueId);
		} catch (err) {
			throw this.wrapError(err, `closeIssue(${issueId})`);
		}
	}

	async listPlans(ctx: TrackerContext): Promise<readonly PlanSummary[]> {
		const localPath = this.requireLocalPath(ctx);
		try {
			return await listPlans(this.deps, localPath);
		} catch (err) {
			throw this.wrapError(err, "listPlans()");
		}
	}

	async getPlan(ctx: TrackerContext, planId: string): Promise<Plan> {
		const localPath = this.requireLocalPath(ctx);
		let result: PlanShowResult;
		try {
			result = await showPlan(this.deps, localPath, planId);
		} catch (err) {
			// A missing PLAN is not a missing ISSUE — the contract reserves
			// IssueNotFoundError for getIssue, so a plan not-found stays a plain
			// TrackerError carrying the cause.
			if (err instanceof SeedNotFoundError) {
				throw new TrackerError(`SeedsTracker getPlan(${planId}) failed: ${err.message}`, {
					cause: err,
					recoveryHint: err.recoveryHint,
				});
			}
			throw this.wrapError(err, `getPlan(${planId})`);
		}
		if (!isPlanStatus(result.status)) {
			throw new TrackerError(
				`sd plan show ${planId} returned unknown plan status '${result.status}'; ` +
					`expected one of ${PLAN_STATUSES.join(", ")}`,
			);
		}
		const steps = result.sections?.steps?.map((step) => ({
			...(step.title !== undefined ? { title: step.title } : {}),
			...(step.existing_seed !== undefined ? { existingSeed: step.existing_seed } : {}),
			...(step.blocks !== undefined ? { blocks: step.blocks } : {}),
		}));
		const plan: Plan = {
			id: result.id,
			status: result.status,
			children: result.children,
			...(steps !== undefined ? { steps } : {}),
		};
		return plan;
	}

	async mergeIssueMetadata(
		ctx: TrackerContext,
		issueId: string,
		metadata: Readonly<Record<string, unknown>>,
	): Promise<void> {
		const localPath = this.requireLocalPath(ctx);
		const parsed = WarrenExtensionsSchema.safeParse(metadata);
		if (!parsed.success) {
			throw new TrackerError(
				`mergeIssueMetadata(${issueId}) payload did not match the warren-namespaced ` +
					`extension schema: ${parsed.error.issues
						.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
						.join("; ")}`,
				{ recoveryHint: METADATA_RECOVERY_HINT },
			);
		}
		try {
			await updateExtensions(this.deps, localPath, issueId, parsed.data);
		} catch (err) {
			throw this.wrapError(err, `mergeIssueMetadata(${issueId})`);
		}
	}

	async listScheduledIssues(ctx: TrackerContext): Promise<readonly ScheduledIssue[]> {
		const localPath = this.requireLocalPath(ctx);
		let scheduled: ParseScheduledSeedsResult;
		try {
			scheduled = await listScheduledSeeds(this.deps, localPath);
		} catch (err) {
			throw this.wrapError(err, "listScheduledIssues()");
		}
		return scheduled.scheduled.map(
			(seed): ScheduledIssue => ({
				id: seed.id,
				status: normalizeIssueStatus(seed.status),
				...(seed.title !== undefined ? { title: seed.title } : {}),
				scheduledFor: seed.scheduledFor,
			}),
		);
	}

	/**
	 * Map facade errors onto the contract's error vocabulary: a definitive
	 * missing id becomes `IssueNotFoundError`, every other seeds shell-out
	 * failure becomes a `TrackerError` carrying the original as `cause`
	 * (plus its recovery hint) so operators keep the copy-paste diagnose
	 * command.
	 */
	private wrapError(err: unknown, op: string): TrackerError {
		if (err instanceof SeedNotFoundError) {
			return new IssueNotFoundError(err.message, { cause: err, recoveryHint: err.recoveryHint });
		}
		if (err instanceof SeedsCliError) {
			return new TrackerError(`SeedsTracker ${op} failed: ${err.message}`, {
				cause: err,
				recoveryHint: err.recoveryHint,
			});
		}
		if (err instanceof TrackerError) return err;
		throw err;
	}
}
