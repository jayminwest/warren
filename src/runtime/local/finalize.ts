/**
 * `LocalProvider.finalize` body (pl-829f step 12 / warren-371a, phase
 * CONTRACT) — the load-bearing §4 seam. Runs the workspace-DEPENDENT half of
 * reap while the burrow workspace is still live and returns structured deltas
 * the domain applies to its project clone.
 *
 * This is a THIN host-side WRAPPER over the EXISTING reap merge functions —
 * it imports and calls them, it does NOT fork their logic:
 *
 *   - `mergeMulch`  (`src/runs/reap/mulch.ts`)      — expertise LWW merge
 *   - `mirrorSeeds` / `mirrorPlans` (`.../seeds.ts`) — issue + plan mirror
 *   - `mergePlot`   (`.../plot-merge.ts`)            — plot event/state replay
 *   - `stagePlotForCommit` / `stageSeedsForCommit` (`.../stage.ts`) — the
 *     `chore(warren): {plot,seeds} state` bookkeeping commits that reap authors
 *     before `git push`, so the pushed branch is byte-identical to reap's.
 *
 * ZERO BEHAVIOR CHANGE for existing reap: `reapRun` / `runReapPipeline` are
 * untouched. finalize is a PARALLEL, independently-tested entry point (step 12);
 * step 13 routes the domain reap call-site through it. Under LocalProvider the
 * merges write host-side into the project clone (the shared disk), exactly as
 * reap does; the returned deltas ALSO capture the merged result so the shape is
 * exercised for the K8s in-pod finalize (step 20), where there is no clone in
 * the pod and the control plane applies the deltas instead.
 *
 * ## What finalize deliberately does NOT do
 *
 *   - **PR open / preview / auto-plan-run / terminal-state transition** — these
 *     are DOMAIN orchestration (design §4: "when to reap, whether to open a PR,
 *     plan-run chaining" stay in the domain). finalize only crosses the seam
 *     with the workspace-touching execution.
 *   - **`intent.closeSeedId` (`sd close` safety net)** — reap's `closeRunSeedId`
 *     runs the seeds CLI against the CLONE, a domain integration (`SeedsCliDeps`)
 *     with no home in the provider seam. Carried on the intent as a forward
 *     declaration; the domain still performs it at the call-site (step 13). This
 *     mirrors how `create()` left the warren-row unwind to the domain.
 *   - **Soft per-file merge failures** — the reap merge helpers swallow
 *     individual malformed lines best-effort (a `reap_failed` event in reap).
 *     finalize passes them a discarding `fail`, so the stage trail records only
 *     the top-level outcome (did the whole stage throw). Same best-effort
 *     posture as reap; the domain owns fine-grained failure inference (§3).
 */

import { join } from "node:path";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { EventRow } from "../../db/schema.ts";
import { mergeMulch } from "../../runs/reap/mulch.ts";
import { mergePlot } from "../../runs/reap/plot-merge.ts";
import { mirrorPlans, mirrorSeeds } from "../../runs/reap/seeds.ts";
import { stagePlotForCommit, stageSeedsForCommit } from "../../runs/reap/stage.ts";
import type { ReapExec, ReapFs } from "../../runs/reap/types.ts";
import { defaultExec, defaultFs } from "../../runs/reap/util.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	FinalizeStage,
	FinalizeStageOutcome,
	MulchDelta,
	MulchDeltaFile,
	PlansDelta,
	PlotDelta,
	RunHandle,
	SeedsDelta,
} from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";

/** Clone-relative (posix) tracker paths — the delta `path` fields + read-back keys. */
const MULCH_EXPERTISE_REL = ".mulch/expertise";
const SEEDS_ISSUES_REL = ".seeds/issues.jsonl";
const SEEDS_PLANS_REL = ".seeds/plans.jsonl";

/**
 * The reap merge helpers `await emit(...)` / `await fail(...)` but finalize
 * never reads the returned row and discards the events (the seam returns
 * structured deltas, not a warren event stream). A placeholder cast is sound —
 * every callee ignores the `emit` return value. Verified against `mergeMulch`,
 * `mirrorSeeds`, `mirrorPlans`, `mergePlot`, and both `stage*` helpers.
 */
const DISCARDED_EVENT_ROW = {} as unknown as EventRow;
async function discardEmit(): Promise<EventRow> {
	return DISCARDED_EVENT_ROW;
}
async function discardFail(): Promise<void> {
	// best-effort swallow — see module doc "Soft per-file merge failures".
}

/** Collects per-stage outcomes for `FinalizeResult.stages`. */
class StageTrail {
	readonly outcomes: FinalizeStageOutcome[] = [];
	ok(stage: FinalizeStage): void {
		this.outcomes.push({ stage, status: "ok" });
	}
	skipped(stage: FinalizeStage): void {
		this.outcomes.push({ stage, status: "skipped" });
	}
	failed(stage: FinalizeStage, err: unknown): void {
		this.outcomes.push({
			stage,
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Injectable disk/shell seam so tests drive finalize without touching a real FS. */
export interface FinalizeDeps {
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
}

/**
 * Run the workspace-dependent half of reap against the run's live burrow
 * workspace and assemble a `FinalizeResult`. `client` is the resolved
 * single-container burrow client; `handle.sandboxId` is the burrowId.
 */
export async function finalizeLocalRun(
	client: BurrowClient,
	handle: RunHandle,
	intent: FinalizeIntent,
	deps: FinalizeDeps = {},
): Promise<FinalizeResult> {
	const fs = deps.fs ?? defaultFs;
	const exec = deps.exec ?? defaultExec;
	const trail = new StageTrail();
	const mirror = new Set(intent.mirror);
	const workspacePath = await resolveWorkspacePath(client, handle.sandboxId);
	const clonePath = resolveClonePath(intent, mirror);

	const mulch = mirror.has("mulch")
		? await finalizeMulch(workspacePath, clonePath, fs, trail)
		: undefined;
	const seeds = mirror.has("seeds")
		? await finalizeSeeds(client, handle.sandboxId, clonePath, fs, trail)
		: undefined;
	const plans = mirror.has("plans")
		? await finalizePlans(client, handle.sandboxId, clonePath, fs, trail)
		: undefined;
	const plot = mirror.has("plot")
		? await finalizePlot(workspacePath, clonePath, fs, trail)
		: undefined;

	// Bookkeeping commits BEFORE push, in reap's order (plot then seeds), so the
	// pushed branch carries the `chore(warren): … state` commits reap authors.
	if (mirror.has("plot")) {
		await finalizePlotCommit(workspacePath, clonePath, fs, exec, trail);
	}
	if (mirror.has("seeds")) {
		await finalizeSeedsCommit(workspacePath, clonePath, fs, exec, trail);
	}

	const push = await finalizePush(intent, workspacePath, exec, trail);
	const prBranch =
		push.pushed && push.commitsAhead !== null && push.commitsAhead > 0 ? intent.branch : null;

	return {
		pushed: push.pushed,
		commitsAhead: push.commitsAhead,
		emptyPush: push.emptyPush,
		mirror: {
			...(mulch !== undefined ? { mulch } : {}),
			...(seeds !== undefined ? { seeds } : {}),
			...(plans !== undefined ? { plans } : {}),
			...(plot !== undefined ? { plot } : {}),
		},
		prBranch,
		stages: trail.outcomes,
	};
}

/**
 * Look up the live workspace path from burrow (`GET /burrows/:id`) — the same
 * lookup `reapRun` does before dispatching the pipeline. Transport-mapped so a
 * dead socket surfaces as `BurrowUnreachableError`.
 */
async function resolveWorkspacePath(client: BurrowClient, sandboxId: string): Promise<string> {
	const burrow = await withTransportMapping(client.config, () =>
		client.http.burrows.get(sandboxId),
	);
	const workspacePath = burrow.workspacePath;
	if (typeof workspacePath !== "string" || workspacePath === "") {
		throw new RuntimeProviderError(
			`LocalProvider.finalize: burrow ${sandboxId} exposed no workspace path`,
			{
				recoveryHint:
					"the burrow backend merges each tracker host-side off the live workspace; " +
					"a burrow with no workspacePath cannot be finalized (it may already be torn down)",
			},
		);
	}
	return workspacePath;
}

/**
 * Resolve the host project-clone path the merges write into. Returns `""` (an
 * unused sentinel) when `mirror` is empty; otherwise the hint is mandatory —
 * the burrow backend cannot merge without it (mirrors `create()`'s hard error
 * on a missing `hostClonePathHint`).
 */
function resolveClonePath(intent: FinalizeIntent, mirror: Set<string>): string {
	if (mirror.size === 0) return "";
	const hint = intent.projectClonePathHint;
	if (hint === undefined || hint === "") {
		throw new RuntimeProviderError(
			"LocalProvider.finalize requires intent.projectClonePathHint when mirror is non-empty",
			{
				recoveryHint:
					"the burrow backend merges each tracker host-side into the project clone; " +
					"supply projectClonePathHint on the FinalizeIntent (the K8s backend ignores it)",
			},
		);
	}
	return hint;
}

async function finalizeMulch(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
): Promise<MulchDelta> {
	try {
		const result = await mergeMulch(workspacePath, clonePath, fs, discardEmit, discardFail);
		const files = await readMergedMulchFiles(workspacePath, clonePath, fs);
		trail.ok("mulch_merge");
		return {
			version: 1,
			updated: result.updated,
			skipped: result.skipped,
			appended: result.appended,
			files,
		};
	} catch (err) {
		trail.failed("mulch_merge", err);
		return { version: 1, updated: 0, skipped: 0, appended: 0, files: [] };
	}
}

/**
 * Read the post-merge body of every domain file the workspace carried, back
 * from the clone (the merge just wrote them there). Scoped to the workspace's
 * expertise files — the exact set `mergeMulch` iterated — so untouched
 * pre-existing project domains never leak into the delta.
 */
async function readMergedMulchFiles(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
): Promise<MulchDeltaFile[]> {
	const names = (await fs.readdir(join(workspacePath, ".mulch", "expertise")))
		.filter((n) => n.endsWith(".jsonl"))
		.sort();
	const files: MulchDeltaFile[] = [];
	for (const name of names) {
		const mergedBody = (await fs.readFile(join(clonePath, ".mulch", "expertise", name))) ?? "";
		files.push({
			domain: name.slice(0, -".jsonl".length),
			path: `${MULCH_EXPERTISE_REL}/${name}`,
			mergedBody,
		});
	}
	return files;
}

async function finalizeSeeds(
	client: BurrowClient,
	sandboxId: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
): Promise<SeedsDelta> {
	try {
		const result = await mirrorSeeds({
			burrowClient: client,
			burrowId: sandboxId,
			projectPath: clonePath,
			fs,
			emit: discardEmit,
		});
		const changed = result.closed + result.created > 0;
		const mergedBody = changed
			? ((await fs.readFile(join(clonePath, ".seeds", "issues.jsonl"))) ?? null)
			: null;
		trail.ok("seeds_mirror");
		return {
			version: 1,
			closed: result.closed,
			created: result.created,
			path: SEEDS_ISSUES_REL,
			mergedBody,
		};
	} catch (err) {
		trail.failed("seeds_mirror", err);
		return { version: 1, closed: 0, created: 0, path: SEEDS_ISSUES_REL, mergedBody: null };
	}
}

async function finalizePlans(
	client: BurrowClient,
	sandboxId: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
): Promise<PlansDelta> {
	try {
		const appended = await mirrorPlans({
			burrowClient: client,
			burrowId: sandboxId,
			projectPath: clonePath,
			fs,
			emit: discardEmit,
		});
		const mergedBody =
			appended > 0 ? ((await fs.readFile(join(clonePath, ".seeds", "plans.jsonl"))) ?? null) : null;
		trail.ok("plans_mirror");
		return { version: 1, appended, path: SEEDS_PLANS_REL, mergedBody };
	} catch (err) {
		trail.failed("plans_mirror", err);
		return { version: 1, appended: 0, path: SEEDS_PLANS_REL, mergedBody: null };
	}
}

async function finalizePlot(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
): Promise<PlotDelta> {
	try {
		const result = await mergePlot(workspacePath, clonePath, fs, discardEmit, discardFail);
		trail.ok("plot_merge");
		return {
			version: 1,
			eventsAppended: result.eventsAppended,
			plotsUpdated: result.plotsUpdated,
			mirrored: result.mirrored,
		};
	} catch (err) {
		trail.failed("plot_merge", err);
		return { version: 1, eventsAppended: 0, plotsUpdated: 0, mirrored: 0 };
	}
}

async function finalizePlotCommit(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	exec: ReapExec,
	trail: StageTrail,
): Promise<void> {
	try {
		await stagePlotForCommit({
			workspacePath,
			projectPath: clonePath,
			fs,
			exec,
			emit: discardEmit,
		});
		trail.ok("plot_commit");
	} catch (err) {
		trail.failed("plot_commit", err);
	}
}

async function finalizeSeedsCommit(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	exec: ReapExec,
	trail: StageTrail,
): Promise<void> {
	try {
		await stageSeedsForCommit({
			workspacePath,
			projectPath: clonePath,
			fs,
			exec,
			emit: discardEmit,
		});
		trail.ok("seeds_commit");
	} catch (err) {
		trail.failed("seeds_commit", err);
	}
}

interface PushOutcome {
	pushed: boolean;
	commitsAhead: number | null;
	emptyPush: boolean;
}

/**
 * `git push origin HEAD:<branch>` then the commits-ahead / empty-push count —
 * faithful to reap's `pushStep` + `commitsAheadStep`. `intent.push === false`
 * skips both stages; a missing `baseBranch` skips the count (`commitsAhead:
 * null`); a `rev-list` failure degrades to `null` too.
 */
async function finalizePush(
	intent: FinalizeIntent,
	workspacePath: string,
	exec: ReapExec,
	trail: StageTrail,
): Promise<PushOutcome> {
	if (!intent.push) {
		trail.skipped("branch_push");
		trail.skipped("commits_ahead");
		return { pushed: false, commitsAhead: null, emptyPush: false };
	}
	try {
		await exec.run("git", ["push", "origin", `HEAD:${intent.branch}`], {
			cwd: workspacePath,
			timeoutMs: 60_000,
		});
		trail.ok("branch_push");
	} catch (err) {
		trail.failed("branch_push", err);
		trail.skipped("commits_ahead");
		return { pushed: false, commitsAhead: null, emptyPush: false };
	}
	const commitsAhead = await countCommitsAhead(intent, workspacePath, exec, trail);
	return { pushed: true, commitsAhead, emptyPush: commitsAhead === 0 };
}

async function countCommitsAhead(
	intent: FinalizeIntent,
	workspacePath: string,
	exec: ReapExec,
	trail: StageTrail,
): Promise<number | null> {
	if (intent.baseBranch === undefined || intent.baseBranch === "") {
		trail.skipped("commits_ahead");
		return null;
	}
	try {
		const out = await exec.run("git", ["rev-list", "--count", `${intent.baseBranch}..HEAD`], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		const parsed = Number.parseInt(out.stdout.trim(), 10);
		trail.ok("commits_ahead");
		return Number.isFinite(parsed) ? parsed : null;
	} catch (err) {
		trail.failed("commits_ahead", err);
		return null;
	}
}
