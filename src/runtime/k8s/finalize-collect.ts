/**
 * The in-pod finalize COLLECTION (pl-829f step 20 / warren-0d35) — the
 * workspace-touching half of `./finalize-entrypoint.ts`, split out to keep each
 * file inside the size budget. Runs against the live pod `/workspace` and
 * assembles a contract-shaped `FinalizeResult` the entrypoint POSTs back.
 *
 * The collection is WORKSPACE-TRUTH (see the entrypoint module doc): `mergedBody`
 * is the workspace tracker file verbatim; the true LWW merge/counts and the
 * `chore(warren): seeds state` bookkeeping commit are a warren-side apply
 * concern (design §4: "warren applies the returned deltas to its project clone"),
 * proven end-to-end in step 25. Everything here is pure over injectable git/fs
 * seams, so it is unit-testable without a cluster or a real repo.
 */

import { join } from "node:path";
import { parseDirtyPaths } from "../../runs/reap/util.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import type {
	FinalizeEvent,
	FinalizeResult,
	FinalizeStage,
	FinalizeStageOutcome,
	MulchDelta,
	MulchDeltaFile,
	PlansDelta,
	SeedsDelta,
} from "../contract.ts";
import type { InPodFinalizeIntent } from "./finalize-wire.ts";

/** Clone-relative (posix) tracker paths — the delta `path` fields (match `../local/finalize.ts`). */
const MULCH_EXPERTISE_REL = ".mulch/expertise";
const SEEDS_ISSUES_REL = ".seeds/issues.jsonl";
const SEEDS_PLANS_REL = ".seeds/plans.jsonl";

/* -------------------------------------------------------------------------- */
/* Injectable seams (testable without a cluster / real git)                   */
/* -------------------------------------------------------------------------- */

export type FinalizeGitRunner = (
	args: string[],
	opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface FinalizeFs {
	readFile: (path: string) => Promise<string>;
	readdir: (path: string) => Promise<string[]>;
}

/* -------------------------------------------------------------------------- */
/* Stage trail + event collector (mirrors ../local/finalize.ts)               */
/* -------------------------------------------------------------------------- */

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

class EventCollector {
	readonly events: FinalizeEvent[] = [];
	fail(step: string, err: unknown, path?: string): void {
		const message = err instanceof Error ? err.message : String(err);
		this.events.push({
			kind: "reap_failed",
			payload: path !== undefined ? { step, message, path } : { step, message },
		});
	}
}

/* -------------------------------------------------------------------------- */
/* JSONL helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Count non-empty lines in a JSONL body (one record per line). */
export function countJsonlRecords(body: string): number {
	let n = 0;
	for (const line of body.split("\n")) {
		if (line.trim() !== "") n++;
	}
	return n;
}

async function readFileOrNull(fs: FinalizeFs, path: string): Promise<string | null> {
	try {
		return await fs.readFile(path);
	} catch {
		return null;
	}
}

/* -------------------------------------------------------------------------- */
/* Mirror-delta collection (workspace-truth — see module doc)                 */
/* -------------------------------------------------------------------------- */

/**
 * Read every `.mulch/expertise/*.jsonl` file off the workspace into a
 * `MulchDelta`. `mergedBody` is the workspace body verbatim (the LWW merge +
 * counts against warren's clone happen warren-side, step 25); `appended` reports
 * the workspace record count as a "records present" signal, `updated`/`skipped`
 * stay 0. Absent `.mulch/expertise` ⇒ an empty delta.
 */
export async function collectMulchDelta(
	workspacePath: string,
	fs: FinalizeFs,
): Promise<MulchDelta> {
	let names: string[];
	try {
		names = (await fs.readdir(join(workspacePath, ".mulch", "expertise")))
			.filter((n) => n.endsWith(".jsonl"))
			.sort();
	} catch {
		return { version: 1, updated: 0, skipped: 0, appended: 0, files: [] };
	}
	const files: MulchDeltaFile[] = [];
	let appended = 0;
	for (const name of names) {
		const body = (await readFileOrNull(fs, join(workspacePath, ".mulch", "expertise", name))) ?? "";
		appended += countJsonlRecords(body);
		files.push({
			domain: name.slice(0, -".jsonl".length),
			path: `${MULCH_EXPERTISE_REL}/${name}`,
			mergedBody: body,
		});
	}
	return { version: 1, updated: 0, skipped: 0, appended, files };
}

/**
 * Read `.seeds/issues.jsonl` off the workspace into a `SeedsDelta`. `closed` /
 * `created` need warren's clone baseline to diff, so they stay 0 here and are
 * reconciled warren-side on apply (step 25); `mergedBody` carries the workspace
 * body for that apply, or `null` when the file is absent.
 */
export async function collectSeedsDelta(
	workspacePath: string,
	fs: FinalizeFs,
): Promise<SeedsDelta> {
	const body = await readFileOrNull(fs, join(workspacePath, ".seeds", "issues.jsonl"));
	return { version: 1, closed: 0, created: 0, path: SEEDS_ISSUES_REL, mergedBody: body };
}

/** Read `.seeds/plans.jsonl` off the workspace into a `PlansDelta` (append-only). */
export async function collectPlansDelta(
	workspacePath: string,
	fs: FinalizeFs,
): Promise<PlansDelta> {
	const body = await readFileOrNull(fs, join(workspacePath, ".seeds", "plans.jsonl"));
	return {
		version: 1,
		appended: body !== null ? countJsonlRecords(body) : 0,
		path: SEEDS_PLANS_REL,
		mergedBody: body,
	};
}

/* -------------------------------------------------------------------------- */
/* Push collection (faithful to ../local/finalize.ts finalizePush)            */
/* -------------------------------------------------------------------------- */

export interface PushOutcome {
	pushed: boolean;
	commitsAhead: number | null;
	emptyPush: boolean;
	dirty: boolean;
	dirtyPaths: readonly string[];
}

const NO_PUSH: PushOutcome = {
	pushed: false,
	commitsAhead: null,
	emptyPush: false,
	dirty: false,
	dirtyPaths: [],
};

/**
 * `git push origin HEAD:<branch>` then the commits-ahead / empty-push count,
 * faithful to reap's `pushStep` + `commitsAheadStep`. When `intent.gitToken` is
 * set the origin remote is temporarily re-authenticated for the push (the pod's
 * `origin` had its token stripped after clone) and restored after. `push:false`
 * or `""` branch behave as in `../local/finalize.ts`.
 */
async function runPush(
	intent: InPodFinalizeIntent,
	workspacePath: string,
	git: FinalizeGitRunner,
	trail: StageTrail,
	collector: EventCollector,
): Promise<PushOutcome> {
	if (!intent.push) {
		trail.skipped("branch_push");
		trail.skipped("commits_ahead");
		return NO_PUSH;
	}
	const refspec = intent.branch === "" ? "HEAD" : `HEAD:${intent.branch}`;
	const restore = await authenticateOrigin(intent.gitToken, workspacePath, git);
	try {
		const push = await git(["push", "origin", refspec], { cwd: workspacePath, timeoutMs: 60_000 });
		if (push.exitCode !== 0) {
			const err = new Error(push.stderr.trim() || push.stdout.trim() || "git push failed");
			trail.failed("branch_push", err);
			collector.fail("branch_push", err, workspacePath);
			trail.skipped("commits_ahead");
			return NO_PUSH;
		}
		trail.ok("branch_push");
		const commitsAhead = await countCommitsAhead(intent, workspacePath, git, trail);
		// warren-89b0: capture dirty PATHS on a zero-commit push so warren can
		// classify a bookkeeping-only no-op vs a dropped commit (parity with
		// ../local/finalize.ts).
		const dirtyPaths = commitsAhead === 0 ? await workspaceDirtyPaths(workspacePath, git) : [];
		return {
			pushed: true,
			commitsAhead,
			emptyPush: commitsAhead === 0,
			dirty: dirtyPaths.length > 0,
			dirtyPaths,
		};
	} finally {
		await restore();
	}
}

/**
 * Temporarily rewrite `origin` to carry the push token, returning a restore fn.
 * No token ⇒ no-op. Best-effort: a failure to read/rewrite leaves origin as-is
 * and returns a no-op restore (the push then runs against the plain remote and
 * fails cleanly if auth was needed).
 */
async function authenticateOrigin(
	token: string | undefined,
	workspacePath: string,
	git: FinalizeGitRunner,
): Promise<() => Promise<void>> {
	if (token === undefined || token === "") return async () => {};
	const res = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
	if (res.exitCode !== 0) return async () => {};
	const origin = res.stdout.trim();
	const authed = authenticatedCloneUrl(origin, token);
	if (authed === origin) return async () => {};
	const set = await git(["remote", "set-url", "origin", authed], { cwd: workspacePath });
	if (set.exitCode !== 0) return async () => {};
	return async () => {
		await git(["remote", "set-url", "origin", origin], { cwd: workspacePath });
	};
}

async function countCommitsAhead(
	intent: InPodFinalizeIntent,
	workspacePath: string,
	git: FinalizeGitRunner,
	trail: StageTrail,
): Promise<number | null> {
	if (intent.baseBranch === undefined || intent.baseBranch === "") {
		trail.skipped("commits_ahead");
		return null;
	}
	const res = await git(["rev-list", "--count", `${intent.baseBranch}..HEAD`], {
		cwd: workspacePath,
		timeoutMs: 10_000,
	});
	if (res.exitCode !== 0) {
		trail.failed("commits_ahead", new Error(res.stderr.trim() || "git rev-list failed"));
		return null;
	}
	const parsed = Number.parseInt(res.stdout.trim(), 10);
	trail.ok("commits_ahead");
	return Number.isFinite(parsed) ? parsed : null;
}

async function workspaceDirtyPaths(
	workspacePath: string,
	git: FinalizeGitRunner,
): Promise<string[]> {
	const res = await git(["status", "--porcelain"], { cwd: workspacePath });
	if (res.exitCode !== 0) return [];
	return parseDirtyPaths(res.stdout);
}

/* -------------------------------------------------------------------------- */
/* Collection orchestration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run the whole in-pod collection against the live workspace and assemble a
 * contract-shaped `FinalizeResult`. The mirror MERGES gate on `intent.mirror`;
 * the bookkeeping COMMIT (`seeds_commit`) is marked `skipped` —
 * they need warren's clone to union against and are authored warren-side on apply
 * (step 25, see module doc). Every stage is best-effort; the workspace read is
 * captured for auto-plan-run before it would be overwritten (parity with reap's
 * `snapshotWorkspacePlans`).
 */
export async function collectFinalizeResult(
	intent: InPodFinalizeIntent,
	workspacePath: string,
	deps: { fs: FinalizeFs; git: FinalizeGitRunner },
): Promise<FinalizeResult> {
	const trail = new StageTrail();
	const collector = new EventCollector();
	const mirror = new Set(intent.mirror);
	const commit = new Set(intent.commit);

	let mulch: MulchDelta | undefined;
	if (mirror.has("mulch")) {
		mulch = await collectMulchDelta(workspacePath, deps.fs);
		trail.ok("mulch_merge");
	}
	let seeds: SeedsDelta | undefined;
	if (mirror.has("seeds")) {
		seeds = await collectSeedsDelta(workspacePath, deps.fs);
		trail.ok("seeds_mirror");
	}
	let plans: PlansDelta | undefined;
	if (mirror.has("plans")) {
		plans = await collectPlansDelta(workspacePath, deps.fs);
		trail.ok("plans_mirror");
	}

	// Bookkeeping commits are a warren-side apply concern in K8s (no in-pod clone).
	const workspacePlansBody = await readFileOrNull(
		deps.fs,
		join(workspacePath, ".seeds", "plans.jsonl"),
	);
	if (commit.has("seeds")) trail.skipped("seeds_commit");

	const push = await runPush(intent, workspacePath, deps.git, trail, collector);
	const prBranch =
		push.pushed && push.commitsAhead !== null && push.commitsAhead > 0 ? intent.branch : null;

	return {
		pushed: push.pushed,
		commitsAhead: push.commitsAhead,
		emptyPush: push.emptyPush,
		dirty: push.dirty,
		dirtyPaths: push.dirtyPaths,
		workspacePlansBody,
		events: collector.events,
		mirror: {
			...(mulch !== undefined ? { mulch } : {}),
			...(seeds !== undefined ? { seeds } : {}),
			...(plans !== undefined ? { plans } : {}),
		},
		prBranch,
		stages: trail.outcomes,
	};
}
