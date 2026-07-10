/**
 * `LocalProvider.finalize` body (pl-829f step 12 / warren-371a; events+dirty+
 * plans parity refinement warren-1f56, step 13) — the load-bearing §4 seam.
 * Runs the workspace-DEPENDENT half of reap while the burrow workspace is still
 * live and returns structured deltas the domain applies to its project clone.
 *
 * A THIN host-side WRAPPER over the EXISTING reap merge functions (`mergeMulch`,
 * `mirrorSeeds`/`mirrorPlans`, `mergePlot`, `stage{Plot,Seeds}ForCommit`) — it
 * imports and calls them, it does NOT fork their logic; the pushed branch stays
 * byte-identical to reap's.
 *
 * - **Event capture**: the merge functions emit ~10 per-record kinds
 *   (`mulch.record.*`, `seeds.closed/created`, `seeds.plan_mirrored`, `plot.*`,
 *   `reap.{plot,seeds}_committed`) plus per-line/stage `reap_failed`. finalize
 *   hands them a COLLECTING emit/fail (was `discardEmit`/`discardFail`) that
 *   appends `{kind, payload}` to `FinalizeResult.events` for the domain to
 *   re-emit; the counts still ride the mirror deltas.
 * - **Merge vs commit gating**: reap runs the four MERGES unconditionally but
 *   gates the two bookkeeping COMMITS on `project.hasPlot`/`hasSeeds`.
 *   `intent.mirror` gates the merges; `intent.commit` gates the commits
 *   (defaulting to `mirror`), so the domain passes `mirror:[all four]` while
 *   gating commits on the flags — byte-for-byte with reap.
 * - **Deliberately NOT here** (domain-owned, §4): PR-open / preview /
 *   auto-plan-run / terminal-state; `reap.empty_push` (needs the run outcome —
 *   finalize returns `dirty` for it); `intent.closeSeedId` (`sd close` via
 *   `SeedsCliDeps`, no provider-seam home). finalize DOES capture
 *   `workspacePlansBody` (what `snapshotWorkspacePlans` reads before the seeds
 *   commit overwrites it) so auto-plan-run detection survives `terminate`.
 */

import { join } from "node:path";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { EventRow } from "../../db/schema.ts";
import { mergeMulch } from "../../runs/reap/mulch.ts";
import { mergePlot } from "../../runs/reap/plot-merge.ts";
import { mirrorPlans, mirrorSeeds } from "../../runs/reap/seeds.ts";
import { stagePlotForCommit, stageSeedsForCommit } from "../../runs/reap/stage.ts";
import type { ReapExec, ReapFs, ReapStep } from "../../runs/reap/types.ts";
import { defaultExec, defaultFs, isWorkspaceDirty } from "../../runs/reap/util.ts";
import type {
	FinalizeEvent,
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
 * The reap merge helpers `await emit(...)` / `await fail(...)` but never read
 * the returned row. A placeholder cast is sound — every callee ignores the
 * `emit` return value.
 */
const DISCARDED_EVENT_ROW = {} as unknown as EventRow;

/**
 * Collects the merge functions' `emit`/`fail` emissions into
 * `FinalizeResult.events` so the domain can re-emit them (warren-1f56). `emit`
 * captures per-record events verbatim; `fail` captures a `reap_failed` event
 * with the SAME payload shape reap's `fail` builds (`{step, message[, path]}`).
 */
class EventCollector {
	readonly events: FinalizeEvent[] = [];
	emit = async (kind: string, payload: unknown): Promise<EventRow> => {
		this.events.push({ kind, payload });
		return DISCARDED_EVENT_ROW;
	};
	fail = async (step: ReapStep, err: unknown, path?: string): Promise<void> => {
		const message = err instanceof Error ? err.message : String(err);
		this.events.push({
			kind: "reap_failed",
			payload: path !== undefined ? { step, message, path } : { step, message },
		});
	};
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
	const collector = new EventCollector();
	const mirror = new Set(intent.mirror);
	// Commit-gating decouples from merge-gating (warren-1f56); default to
	// `mirror` so pre-existing callers that only passed `mirror` are unchanged.
	const commit = new Set(intent.commit ?? intent.mirror);
	const workspacePath = await resolveWorkspacePath(client, handle.sandboxId);
	const clonePath = resolveClonePath(intent, mirror);

	const mulch = mirror.has("mulch")
		? await finalizeMulch(workspacePath, clonePath, fs, trail, collector)
		: undefined;
	const seeds = mirror.has("seeds")
		? await finalizeSeeds(client, handle.sandboxId, clonePath, fs, trail, collector)
		: undefined;
	const plans = mirror.has("plans")
		? await finalizePlans(client, handle.sandboxId, clonePath, fs, trail, collector)
		: undefined;
	const plot = mirror.has("plot")
		? await finalizePlot(workspacePath, clonePath, fs, trail, collector)
		: undefined;

	// Bookkeeping commits BEFORE push, in reap's order (plot then seeds), so the
	// pushed branch carries the `chore(warren): … state` commits reap authors.
	if (commit.has("plot")) {
		await finalizePlotCommit(workspacePath, clonePath, fs, exec, trail, collector);
	}
	// Snapshot the workspace plans.jsonl BEFORE the seeds commit copies the
	// clone-union over it — this is exactly what reap's `snapshotWorkspacePlans`
	// reads for auto-plan-run detection (warren-1f56), and the workspace is gone
	// after `terminate`, so finalize must capture it here.
	const workspacePlansBody = await captureWorkspacePlans(workspacePath, fs);
	if (commit.has("seeds")) {
		await finalizeSeedsCommit(workspacePath, clonePath, fs, exec, trail, collector);
	}

	const push = await finalizePush(intent, workspacePath, exec, trail, collector);
	const prBranch =
		push.pushed && push.commitsAhead !== null && push.commitsAhead > 0 ? intent.branch : null;

	return {
		pushed: push.pushed,
		commitsAhead: push.commitsAhead,
		emptyPush: push.emptyPush,
		dirty: push.dirty,
		workspacePlansBody,
		mirror: {
			...(mulch !== undefined ? { mulch } : {}),
			...(seeds !== undefined ? { seeds } : {}),
			...(plans !== undefined ? { plans } : {}),
			...(plot !== undefined ? { plot } : {}),
		},
		prBranch,
		stages: trail.outcomes,
		events: collector.events,
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

/**
 * Snapshot the workspace `.seeds/plans.jsonl` body for the domain's
 * auto-plan-run detection (`FinalizeResult.workspacePlansBody`). `null` when the
 * file is absent or the read throws — the same best-effort posture as reap's
 * `snapshotWorkspacePlans` catch.
 */
async function captureWorkspacePlans(workspacePath: string, fs: ReapFs): Promise<string | null> {
	try {
		return await fs.readFile(join(workspacePath, ".seeds", "plans.jsonl"));
	} catch {
		return null;
	}
}

async function finalizeMulch(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
	collector: EventCollector,
): Promise<MulchDelta> {
	try {
		const result = await mergeMulch(workspacePath, clonePath, fs, collector.emit, collector.fail);
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
		await collector.fail("mulch_merge", err);
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
	collector: EventCollector,
): Promise<SeedsDelta> {
	try {
		const result = await mirrorSeeds({
			burrowClient: client,
			burrowId: sandboxId,
			projectPath: clonePath,
			fs,
			emit: collector.emit,
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
		// reap's `mirrorSeedsStep` reports this failure as step `seeds_close`.
		await collector.fail("seeds_close", err);
		return { version: 1, closed: 0, created: 0, path: SEEDS_ISSUES_REL, mergedBody: null };
	}
}

async function finalizePlans(
	client: BurrowClient,
	sandboxId: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
	collector: EventCollector,
): Promise<PlansDelta> {
	try {
		const appended = await mirrorPlans({
			burrowClient: client,
			burrowId: sandboxId,
			projectPath: clonePath,
			fs,
			emit: collector.emit,
		});
		const mergedBody =
			appended > 0 ? ((await fs.readFile(join(clonePath, ".seeds", "plans.jsonl"))) ?? null) : null;
		trail.ok("plans_mirror");
		return { version: 1, appended, path: SEEDS_PLANS_REL, mergedBody };
	} catch (err) {
		trail.failed("plans_mirror", err);
		await collector.fail("plans_mirror", err);
		return { version: 1, appended: 0, path: SEEDS_PLANS_REL, mergedBody: null };
	}
}

async function finalizePlot(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
	collector: EventCollector,
): Promise<PlotDelta> {
	try {
		const result = await mergePlot(workspacePath, clonePath, fs, collector.emit, collector.fail);
		trail.ok("plot_merge");
		return {
			version: 1,
			eventsAppended: result.eventsAppended,
			plotsUpdated: result.plotsUpdated,
			mirrored: result.mirrored,
		};
	} catch (err) {
		trail.failed("plot_merge", err);
		await collector.fail("plot_merge", err);
		return { version: 1, eventsAppended: 0, plotsUpdated: 0, mirrored: 0 };
	}
}

async function finalizePlotCommit(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	exec: ReapExec,
	trail: StageTrail,
	collector: EventCollector,
): Promise<void> {
	try {
		await stagePlotForCommit({
			workspacePath,
			projectPath: clonePath,
			fs,
			exec,
			emit: collector.emit,
		});
		trail.ok("plot_commit");
	} catch (err) {
		trail.failed("plot_commit", err);
		await collector.fail("plot_commit", err, join(workspacePath, ".plot"));
	}
}

async function finalizeSeedsCommit(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
	exec: ReapExec,
	trail: StageTrail,
	collector: EventCollector,
): Promise<void> {
	try {
		await stageSeedsForCommit({
			workspacePath,
			projectPath: clonePath,
			fs,
			exec,
			emit: collector.emit,
		});
		trail.ok("seeds_commit");
	} catch (err) {
		trail.failed("seeds_commit", err);
		await collector.fail("seeds_commit", err, join(workspacePath, ".seeds"));
	}
}

interface PushOutcome {
	pushed: boolean;
	commitsAhead: number | null;
	emptyPush: boolean;
	dirty: boolean;
}

/**
 * `git push origin HEAD:<branch>` then the commits-ahead / empty-push count —
 * faithful to reap's `pushStep` + `commitsAheadStep`. `intent.push === false`
 * skips both stages; a missing `baseBranch` skips the count (`commitsAhead:
 * null`); a `rev-list` failure degrades to `null` too. On a zero-commit push it
 * probes `git status --porcelain` for `dirty` (the dropped-commit signal the
 * domain derives `droppedCommit` from). An empty branch pushes `HEAD` (reap's
 * fallback when burrow exposed no branch).
 */
async function finalizePush(
	intent: FinalizeIntent,
	workspacePath: string,
	exec: ReapExec,
	trail: StageTrail,
	collector: EventCollector,
): Promise<PushOutcome> {
	if (!intent.push) {
		trail.skipped("branch_push");
		trail.skipped("commits_ahead");
		return { pushed: false, commitsAhead: null, emptyPush: false, dirty: false };
	}
	const refspec = intent.branch === "" ? "HEAD" : `HEAD:${intent.branch}`;
	try {
		await exec.run("git", ["push", "origin", refspec], {
			cwd: workspacePath,
			timeoutMs: 60_000,
		});
		trail.ok("branch_push");
	} catch (err) {
		trail.failed("branch_push", err);
		await collector.fail("branch_push", err, workspacePath);
		trail.skipped("commits_ahead");
		return { pushed: false, commitsAhead: null, emptyPush: false, dirty: false };
	}
	const commitsAhead = await countCommitsAhead(intent, workspacePath, exec, trail);
	// warren-72b9: probe dirtiness only on a zero-commit push (matching reap) so
	// the domain can tell a dropped commit (staged-but-uncommitted) apart from a
	// deliberate no-op. Any other case leaves `dirty` false — no extra git call.
	const dirty = commitsAhead === 0 ? await isWorkspaceDirty(exec, workspacePath) : false;
	return { pushed: true, commitsAhead, emptyPush: commitsAhead === 0, dirty };
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
		// reap logs the rev-list failure but emits NO `reap_failed` event — the
		// count degrades to null. Record the stage outcome only.
		trail.failed("commits_ahead", err);
		return null;
	}
}
