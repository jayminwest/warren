/**
 * The IN-POD salvage collection (warren-cd3b) — runs inside the run pod before
 * the container exits, because the pod's `emptyDir` workspace is unreachable
 * from the control plane: a warren-side salvage cannot see a dead pod's
 * volume, so the pod must capture the work itself. Driven by
 * `./finalize-entrypoint.ts` in the two loss windows:
 *
 *   - `push_failed` — the reap intent arrived but the primary branch push was
 *     rejected (e.g. GitHub push protection). The rescue-ref push rides the
 *     same short-lived `gitToken`; the bundle POST rides the run's callback
 *     token and survives even a push-protection rejection (the bundle never
 *     touches origin).
 *   - `no_intent` — no reap intent ever arrived (control-plane restart severed
 *     the finalize loop). No intent-carried `gitToken` exists in that window;
 *     the rescue push falls back to the pod-carried `WARREN_GIT_TOKEN` (the
 *     same `warren-git-token` Secret the init container clones with —
 *     warren-6016), and the bundle capture + POST always run.
 *   - `empty_push_dirty` (warren-985e) — the push landed but with zero
 *     commits ahead and a dirty tree: the run died mid-work (e.g.
 *     provider_error credit exhaustion) before its first commit, so the
 *     pushed branch carries nothing and the uncommitted diff is the only
 *     work to save. The dirty-tree fold-in below is what puts that diff
 *     into a commit the rescue ref and bundle can capture.
 *
 * warren-6016: before either capture form runs, a DIRTY tree is folded into a
 * warren bookkeeping commit (`git add -A` + commit with the canonical bot
 * identity from `src/bot-identity.ts`). Salvage exists precisely for the run
 * that died with uncommitted work, and a `main..HEAD` bundle of a dirty tree
 * captures nothing (`fatal: Refusing to create empty bundle`).
 *
 * Everything is pure over injectable git/fs seams (mirroring
 * `./finalize-collect.ts`), so it is unit-testable without a cluster or a real
 * repo. See `../salvage.ts` for the shared salvage vocabulary.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import { MAX_SALVAGE_BUNDLE_BYTES, rescueBranchFor } from "../salvage.ts";
import { authenticateOrigin, type FinalizeGitRunner } from "./finalize-collect.ts";

/** What the in-pod salvage attempt produced (maps onto the SalvageEnvelope). */
export interface InPodSalvage {
	readonly rescueRef: string | null;
	readonly bundleBase64: string | null;
	readonly notes: string[];
}

export interface CollectSalvageInput {
	readonly runId: string;
	readonly workspacePath: string;
	/** Base ref for the bundle range; undefined ⇒ bundle the full `HEAD`. */
	readonly baseBranch: string | undefined;
	/**
	 * Push credential for the rescue push. In the `push_failed` window this is
	 * the intent's short-lived `gitToken`; in the `no_intent` window the caller
	 * falls back to the pod-carried `WARREN_GIT_TOKEN` (warren-6016 — held by
	 * the harness env, scrubbed from the agent child's spawn env, so the agent
	 * itself still never holds it). Absent ⇒ the rescue push is skipped.
	 */
	readonly gitToken: string | undefined;
}

export interface CollectSalvageDeps {
	readonly git: FinalizeGitRunner;
	/** Read a produced bundle back as bytes (defaults are injected by the caller). */
	readonly readFileBytes: (path: string) => Promise<Uint8Array>;
	/** Best-effort temp-bundle cleanup. */
	readonly rm: (path: string) => Promise<void>;
}

/**
 * warren-6016: fold a DIRTY workspace tree into a warren bookkeeping commit so
 * the push/bundle captures have something to save. Salvage exists for exactly
 * the run that settled (or died) with uncommitted work; without this step a
 * `<base>..HEAD` bundle of a dirty tree refuses as empty and the rescue ref
 * points at commits the agent never made. The commit is authored with the
 * canonical bot identity (`src/bot-identity.ts`, Constitution Article VII —
 * never re-spelled inline), `--no-verify` so a project's pre-commit gate can
 * never block a salvage capture, and spawned with the repo-context scrub +
 * identity env so an inherited `GIT_*` can neither redirect the commit nor
 * re-author it. A clean tree, a failed probe, and a failed commit all degrade
 * to a note (or silence) — NEVER a thrown error that would mask the captures.
 */
export async function commitUncommittedWork(
	input: CollectSalvageInput,
	git: FinalizeGitRunner,
	notes: string[],
): Promise<void> {
	const status = await git(["status", "--porcelain"], {
		cwd: input.workspacePath,
		env: gitRepoContextScrubEnv(),
	});
	if (status.exitCode !== 0) {
		notes.push(
			`dirty-tree probe failed: ${status.stderr.trim() || status.stdout.trim() || "git status failed"}`,
		);
		return;
	}
	if (status.stdout.trim() === "") return; // clean tree — nothing to fold in
	const add = await git(["add", "-A"], {
		cwd: input.workspacePath,
		env: gitRepoContextScrubEnv(),
	});
	if (add.exitCode !== 0) {
		notes.push(
			`dirty-tree staging (git add -A) failed: ${add.stderr.trim() || add.stdout.trim() || "git add failed"}`,
		);
		return;
	}
	const commit = await git(
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// A salvage capture must never gate on the project's git hooks.
			"--no-verify",
			"-m",
			`chore(warren): salvage uncommitted workspace work ${input.runId}`,
		],
		{
			cwd: input.workspacePath,
			env: { ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() },
		},
	);
	if (commit.exitCode !== 0) {
		notes.push(
			`dirty-tree salvage commit failed: ${commit.stderr.trim() || commit.stdout.trim() || "git commit failed"}`,
		);
		return;
	}
	notes.push("uncommitted workspace work folded into a warren bookkeeping commit");
}

/**
 * Best-effort rescue-ref push: `git push origin HEAD:refs/heads/warren/rescue/<runId>`
 * over the temporarily re-authenticated origin (same posture as the primary
 * push in `finalize-collect.ts`). Returns the branch name on success, `null` +
 * a note on failure — a rejection here is EXPECTED when the primary push died
 * on push protection (the same history is scanned again).
 */
export async function pushRescueRef(
	input: CollectSalvageInput,
	git: FinalizeGitRunner,
	notes: string[],
): Promise<string | null> {
	if (input.gitToken === undefined || input.gitToken === "") {
		notes.push("rescue push skipped: no git credential available in this window");
		return null;
	}
	const branch = rescueBranchFor(input.runId);
	const restore = await authenticateOrigin(input.gitToken, input.workspacePath, git);
	try {
		const res = await git(["push", "origin", `HEAD:refs/heads/${branch}`], {
			cwd: input.workspacePath,
			timeoutMs: 60_000,
		});
		if (res.exitCode !== 0) {
			notes.push(
				`rescue push to ${branch} failed: ${res.stderr.trim() || res.stdout.trim() || "git push failed"}`,
			);
			return null;
		}
		return branch;
	} finally {
		await restore();
	}
}

/**
 * Capture the run's commits as a git bundle and return it base64-encoded.
 * Range is `<baseBranch>..HEAD` when a base is known (the deltas reap would
 * have pushed), else the full `HEAD` history. An empty range (no commits
 * ahead — nothing to lose) and an over-cap bundle both degrade to `null` +
 * a note rather than throwing.
 */
export async function buildSalvageBundle(
	input: CollectSalvageInput,
	deps: CollectSalvageDeps,
	notes: string[],
): Promise<string | null> {
	const range =
		input.baseBranch !== undefined && input.baseBranch !== ""
			? `${input.baseBranch}..HEAD`
			: "HEAD";
	const tmpPath = join(tmpdir(), `warren-salvage-${input.runId}.bundle`);
	try {
		const res = await deps.git(["bundle", "create", tmpPath, range], {
			cwd: input.workspacePath,
			timeoutMs: 60_000,
		});
		if (res.exitCode !== 0) {
			notes.push(
				`bundle capture (${range}) failed: ${res.stderr.trim() || res.stdout.trim() || "git bundle failed"}`,
			);
			return null;
		}
		const bytes = await deps.readFileBytes(tmpPath);
		if (bytes.byteLength > MAX_SALVAGE_BUNDLE_BYTES) {
			notes.push(
				`bundle capture (${range}) produced ${bytes.byteLength} bytes, over the ${MAX_SALVAGE_BUNDLE_BYTES}-byte cap; not posted`,
			);
			return null;
		}
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary);
	} finally {
		await deps.rm(tmpPath);
	}
}

/**
 * Run both capture forms and fold them into one result. Never throws — every
 * failure lands in `notes` so the caller can still POST whatever was captured
 * (or an all-null envelope that tells warren "nothing recoverable", which is
 * itself operator-visible signal).
 */
export async function collectSalvage(
	input: CollectSalvageInput,
	deps: CollectSalvageDeps,
): Promise<InPodSalvage> {
	const notes: string[] = [];
	let rescueRef: string | null = null;
	let bundleBase64: string | null = null;
	// warren-6016: commit a dirty tree FIRST so both captures see the work.
	try {
		await commitUncommittedWork(input, deps.git, notes);
	} catch (err) {
		notes.push(
			`dirty-tree salvage commit errored: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		rescueRef = await pushRescueRef(input, deps.git, notes);
	} catch (err) {
		notes.push(`rescue push errored: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		bundleBase64 = await buildSalvageBundle(input, deps, notes);
	} catch (err) {
		notes.push(`bundle capture errored: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { rescueRef, bundleBase64, notes };
}
