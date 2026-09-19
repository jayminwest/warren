import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitRepoContextScrubEnv } from "../../bot-identity.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { AutoMergeConfig } from "../../warren-config/pr-config.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import type { RunAutoMergeArmInput } from "./auto-merge-arm.ts";
import { computeAutoMergeChangedPaths, readBaseAutoMergeConfig } from "./auto-merge-git.ts";
import type { ChangedPaths } from "./auto-merge-policy.ts";
import type { ReapExec } from "./types.ts";

interface AutoMergeSnapshot {
	config: AutoMergeConfig | undefined;
	changedPaths: ChangedPaths;
}

/**
 * Read current remote policy at arm time, including coordinator reopens.
 * LocalProvider exposes the shared clone's refs AND config for agent writes.
 * A fresh repository avoids trusting either, including remote URL rewrites,
 * replacement objects, and stale refs after a failed fetch (warren-8908).
 * Keep it beside the host clone: macOS sandboxes can write the system temp
 * directory, but cannot write siblings of their mounted Git directory.
 */
export async function readAutoMergeSnapshot(
	input: RunAutoMergeArmInput,
): Promise<AutoMergeSnapshot> {
	let config: AutoMergeConfig | undefined;
	const cwd = await mkdtemp(join(dirname(input.project.localPath), ".warren-auto-merge-"));
	const exec: ReapExec = {
		run: (cmd, args, opts) => input.exec.run(cmd, args, { ...opts, env: gitRepoContextScrubEnv() }),
	};
	try {
		await exec.run("git", ["init", "--bare", "--template="], { cwd, timeoutMs: 10_000 });
		const credential = await mintGitCredential(input.forge, input.project.gitUrl);
		const url = authenticatedCloneUrl(input.project.gitUrl, credential);
		const base = await fetchCommit(exec, cwd, url, input.baseBranch, "base");
		config = await readBaseAutoMergeConfig(exec, cwd, base);
		const head = await fetchCommit(exec, cwd, url, input.branch, "head");
		return { config, changedPaths: await computeAutoMergeChangedPaths(exec, cwd, base, head) };
	} catch {
		// Never expose fetch errors: their text can contain the minted credential.
		// A failed base read is off; a failed head read is diff_unreadable.
		return { config, changedPaths: { kind: "unreadable" } };
	} finally {
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

async function fetchCommit(
	exec: ReapExec,
	cwd: string,
	url: string,
	branch: string,
	slot: "base" | "head",
): Promise<string> {
	await exec.run("git", ["check-ref-format", `refs/heads/${branch}`], {
		cwd,
		timeoutMs: 10_000,
	});
	const ref = `refs/warren/auto-merge/${slot}`;
	await exec.run(
		"git",
		["fetch", "--no-tags", "--force", "--", url, `refs/heads/${branch}:${ref}`],
		{ cwd, timeoutMs: 30_000 },
	);
	const result = await exec.run("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
		cwd,
		timeoutMs: 10_000,
	});
	const sha = result.stdout.trim();
	if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid fetched commit SHA");
	return sha;
}
