/**
 * `LocalProvider.finalize` body (pl-829f step 12 / warren-371a; events+dirty+
 * plans parity refinement warren-1f56, step 13) — the load-bearing §4 seam. Runs
 * the workspace-DEPENDENT half of reap while the burrow workspace is still live
 * and returns structured deltas the domain applies to its project clone.
 *
 * A THIN host-side WRAPPER over the EXISTING reap merge functions (`mergeMulch`,
 * `mirrorSeeds`/`mirrorPlans`, `stageSeedsForCommit`, plus the warren-8d95
 * `finalizeSeedReset`) — it calls them, it does NOT fork their logic; the pushed
 * branch stays reap's.
 *
 * ## Burrow file-reads live HERE (warren-fbbf)
 *
 * `mirrorSeeds`/`mirrorPlans` are pure string→clone merges now; the burrow
 * `http.files.read` for `.seeds/{issues,plans}.jsonl` was evicted from
 * `src/runs/reap/seeds.ts` into this module (`readWorkspaceTracker`) — the ONE
 * finalize-path burrow read. `NotFoundError` maps to `null` (no-op mirror),
 * keeping reap core free of burrow-client imports.
 *
 * - **Event capture**: the merge functions emit ~10 per-record kinds
 *   (`mulch.record.*`, `seeds.closed/created`, `seeds.plan_mirrored`,
 *   `reap.seeds_committed`) plus per-line/stage `reap_failed`. finalize
 *   hands them a COLLECTING emit/fail that appends `{kind, payload}` to
 *   `FinalizeResult.events` for the domain to re-emit; counts ride the deltas.
 * - **Merge vs commit gating**: `intent.artifacts` gates the three merges;
 *   `commit` (default = the merge set) gates the seeds bookkeeping commit.
 * - **Deliberately NOT here** (domain-owned, §4): PR-open / preview /
 *   auto-plan-run / terminal-state; `reap.empty_push` (needs the run outcome —
 *   finalize returns `dirty` + dirtyPaths for it); `intent.closeSeedId`.
 *   finalize DOES capture `workspacePlansBody` so auto-plan-run survives terminate.
 */

import { join } from "node:path";
import { NotFoundError } from "@os-eco/burrow-cli";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { EventRow } from "../../db/schema.ts";
import { mergeMulch } from "../../runs/reap/mulch.ts";
import { mirrorPlans, mirrorSeeds } from "../../runs/reap/seeds.ts";
import { stageSeedsForCommit } from "../../runs/reap/stage.ts";
import type { ReapExec, ReapFs, ReapStep } from "../../runs/reap/types.ts";
import { defaultExec, defaultFs, workspaceDirtyPaths } from "../../runs/reap/util.ts";
import type {
	ArtifactDelta,
	ArtifactDeltaFile,
	FinalizeEvent,
	FinalizeIntent,
	FinalizeResult,
	FinalizeStage,
	FinalizeStageOutcome,
	RunHandle,
} from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import { finalizeSeedReset } from "./finalize-seed-reset.ts";

/** Clone-relative (posix) tracker paths — the delta `path` fields + read-back keys. */
const MULCH_EXPERTISE_REL = ".mulch/expertise";
const SEEDS_ISSUES_REL = ".seeds/issues.jsonl";
const SEEDS_PLANS_REL = ".seeds/plans.jsonl";

/** The merge helpers ignore `emit`'s return row, so a placeholder cast is sound. */
const DISCARDED_EVENT_ROW = {} as unknown as EventRow;

/**
 * Collects the merge functions' `emit`/`fail` emissions into
 * `FinalizeResult.events` so the domain can re-emit them (warren-1f56); `fail`
 * mirrors reap's `reap_failed` payload shape (`{step, message[, path]}`).
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
	const artifacts = new Set(intent.artifacts);
	// Commit-gating decouples from merge-gating (warren-1f56); default to the merge set.
	const commit = new Set(intent.commit ?? intent.artifacts);
	const workspacePath = await resolveWorkspacePath(client, handle.sandboxId);
	const clonePath = resolveClonePath(intent, artifacts);

	const mulch = artifacts.has("mulch")
		? await finalizeMulch(workspacePath, clonePath, fs, trail, collector)
		: undefined;
	const seeds = artifacts.has("seeds")
		? await finalizeSeeds(client, handle.sandboxId, clonePath, fs, trail, collector)
		: undefined;
	const plans = artifacts.has("plans")
		? await finalizePlans(client, handle.sandboxId, clonePath, fs, trail, collector)
		: undefined;

	// Snapshot the workspace plans.jsonl BEFORE the seeds commit copies the
	// clone-union over it — this is exactly what reap's `snapshotWorkspacePlans`
	// reads for auto-plan-run detection (warren-1f56), and the workspace is gone
	// after `terminate`, so finalize must capture it here.
	const workspacePlansBody = await captureWorkspacePlans(workspacePath, fs);
	if (commit.has("seeds")) {
		await finalizeSeedsCommit(workspacePath, clonePath, fs, exec, trail, collector);
	}

	await finalizeSeedReset(intent, workspacePath, fs, exec, trail, collector);

	const push = await finalizePush(intent, workspacePath, exec, trail, collector);
	const prBranch =
		push.pushed && push.commitsAhead !== null && push.commitsAhead > 0 ? intent.branch : null;

	return {
		pushed: push.pushed,
		commitsAhead: push.commitsAhead,
		emptyPush: push.emptyPush,
		dirty: push.dirty,
		dirtyPaths: push.dirtyPaths,
		workspacePlansBody,
		artifacts: {
			...(mulch !== undefined ? { mulch } : {}),
			...(seeds !== undefined ? { seeds } : {}),
			...(plans !== undefined ? { plans } : {}),
		},
		prBranch,
		stages: trail.outcomes,
		events: collector.events,
	};
}

/**
 * Look up the live workspace path from burrow (`GET /burrows/:id`). Transport-
 * mapped so a dead socket surfaces as `BurrowUnreachableError`.
 */
async function resolveWorkspacePath(client: BurrowClient, sandboxId: string): Promise<string> {
	const burrow = await withTransportMapping(client.config, () =>
		client.http.burrows.get(sandboxId),
	);
	const workspacePath = burrow.workspacePath;
	if (typeof workspacePath !== "string" || workspacePath === "") {
		throw new RuntimeProviderError(
			`LocalProvider.finalize: burrow ${sandboxId} exposed no workspace path`,
			{ recoveryHint: "a burrow with no workspacePath cannot be finalized (already torn down?)" },
		);
	}
	return workspacePath;
}

/**
 * Resolve the host project-clone path the merges write into. `""` (unused
 * sentinel) when `artifacts` is empty; otherwise the hint is mandatory — the
 * burrow backend cannot merge without it (mirrors `create()`'s `hostClonePathHint`).
 */
function resolveClonePath(intent: FinalizeIntent, artifacts: Set<string>): string {
	if (artifacts.size === 0) return "";
	const hint = intent.projectClonePathHint;
	if (hint === undefined || hint === "") {
		throw new RuntimeProviderError(
			"LocalProvider.finalize requires intent.projectClonePathHint when artifacts is non-empty",
			{ recoveryHint: "supply projectClonePathHint on the FinalizeIntent (K8s ignores it)" },
		);
	}
	return hint;
}

/** Snapshot workspace `.seeds/plans.jsonl` for auto-plan-run detection; `null` if absent. */
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
): Promise<ArtifactDelta> {
	try {
		const result = await mergeMulch(workspacePath, clonePath, fs, collector.emit, collector.fail);
		const files = await readMergedMulchFiles(workspacePath, clonePath, fs);
		trail.ok("mulch_merge");
		return {
			version: 1,
			files,
			counts: { updated: result.updated, skipped: result.skipped, appended: result.appended },
		};
	} catch (err) {
		trail.failed("mulch_merge", err);
		await collector.fail("mulch_merge", err);
		return { version: 1, files: [], counts: { updated: 0, skipped: 0, appended: 0 } };
	}
}

/**
 * Read back the post-merge body of every domain file the workspace carried,
 * scoped to the expertise files `mergeMulch` iterated so untouched project
 * domains never leak into the delta.
 */
async function readMergedMulchFiles(
	workspacePath: string,
	clonePath: string,
	fs: ReapFs,
): Promise<ArtifactDeltaFile[]> {
	const names = (await fs.readdir(join(workspacePath, ".mulch", "expertise")))
		.filter((n) => n.endsWith(".jsonl"))
		.sort();
	const files: ArtifactDeltaFile[] = [];
	for (const name of names) {
		const mergedBody = (await fs.readFile(join(clonePath, ".mulch", "expertise", name))) ?? "";
		files.push({
			path: `${MULCH_EXPERTISE_REL}/${name}`,
			mergedBody,
		});
	}
	return files;
}

/**
 * Read a workspace tracker file off the live burrow (warren-fbbf). `null` on
 * `NotFoundError`; any other error propagates to a failed stage.
 */
async function readWorkspaceTracker(
	client: BurrowClient,
	sandboxId: string,
	relPath: string,
): Promise<string | null> {
	try {
		const out = await withTransportMapping(client.config, () =>
			client.http.files.read(sandboxId, relPath),
		);
		return out.contents;
	} catch (err) {
		if (err instanceof NotFoundError) return null;
		throw err;
	}
}

async function finalizeSeeds(
	client: BurrowClient,
	sandboxId: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
	collector: EventCollector,
): Promise<ArtifactDelta> {
	try {
		const workspaceBody = await readWorkspaceTracker(client, sandboxId, ".seeds/issues.jsonl");
		const result = await mirrorSeeds({
			workspaceBody,
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
			files: singleFile(SEEDS_ISSUES_REL, mergedBody),
			counts: { closed: result.closed, created: result.created },
		};
	} catch (err) {
		trail.failed("seeds_mirror", err);
		// reap's `mirrorSeedsStep` reports this failure as step `seeds_close`.
		await collector.fail("seeds_close", err);
		return { version: 1, files: [], counts: { closed: 0, created: 0 } };
	}
}

/** One-entry `files[]` when a mirror produced a body; empty on a no-op merge. */
function singleFile(path: string, mergedBody: string | null): ArtifactDeltaFile[] {
	return mergedBody != null ? [{ path, mergedBody }] : [];
}

async function finalizePlans(
	client: BurrowClient,
	sandboxId: string,
	clonePath: string,
	fs: ReapFs,
	trail: StageTrail,
	collector: EventCollector,
): Promise<ArtifactDelta> {
	try {
		const workspaceBody = await readWorkspaceTracker(client, sandboxId, ".seeds/plans.jsonl");
		const appended = await mirrorPlans({
			workspaceBody,
			projectPath: clonePath,
			fs,
			emit: collector.emit,
		});
		const mergedBody =
			appended > 0 ? ((await fs.readFile(join(clonePath, ".seeds", "plans.jsonl"))) ?? null) : null;
		trail.ok("plans_mirror");
		return { version: 1, files: singleFile(SEEDS_PLANS_REL, mergedBody), counts: { appended } };
	} catch (err) {
		trail.failed("plans_mirror", err);
		await collector.fail("plans_mirror", err);
		return { version: 1, files: [], counts: { appended: 0 } };
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
	dirtyPaths: readonly string[];
}

/**
 * `git push origin HEAD:<branch>` then the commits-ahead / empty-push count —
 * faithful to reap's `pushStep` + `commitsAheadStep`. `push === false` skips
 * both; a missing `baseBranch`/`rev-list` failure yields `commitsAhead: null`. A
 * zero-commit push probes `git status --porcelain` for `dirty` + dirtyPaths (the
 * domain's dropped-commit signal); an empty branch pushes `HEAD`.
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
		return { pushed: false, commitsAhead: null, emptyPush: false, dirty: false, dirtyPaths: [] };
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
		return { pushed: false, commitsAhead: null, emptyPush: false, dirty: false, dirtyPaths: [] };
	}
	const commitsAhead = await countCommitsAhead(intent, workspacePath, exec, trail);
	// warren-72b9/89b0: capture dirty PATHS on a zero-commit push (dropped commit vs no-op).
	const dirtyPaths = commitsAhead === 0 ? await workspaceDirtyPaths(exec, workspacePath) : [];
	const dirty = dirtyPaths.length > 0;
	return { pushed: true, commitsAhead, emptyPush: commitsAhead === 0, dirty, dirtyPaths };
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
		// reap logs the rev-list failure but emits NO `reap_failed` — count → null.
		trail.failed("commits_ahead", err);
		return null;
	}
}
