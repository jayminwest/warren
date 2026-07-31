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
 *     the finalize loop). No `gitToken` exists in that window, so only the
 *     bundle capture + POST runs.
 *
 * Everything is pure over injectable git/fs seams (mirroring
 * `./finalize-collect.ts`), so it is unit-testable without a cluster or a real
 * repo. See `../salvage.ts` for the shared salvage vocabulary.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
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
	 * Short-lived push credential from the finalize intent (present only in the
	 * `push_failed` window). Absent ⇒ the rescue push is skipped (there is no
	 * credential in the pod to authenticate it with — by design, the agent
	 * container never holds one).
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
