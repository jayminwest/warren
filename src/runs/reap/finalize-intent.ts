/**
 * Finalize-intent construction + the §4 seam call (extracted from
 * `pipeline.ts`, warren-4e1c — frozen size budget). Builds the neutral
 * `FinalizeIntent` the domain hands to `provider.finalize`, including the
 * per-spawn minted push credential.
 */

import { mintGitCredential } from "../../forge/credentials.ts";
import type { FinalizeIntent, FinalizeResult, RunHandle } from "../../runtime/contract.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import type { ReapPipelineContext } from "./pipeline.ts";
import { seededArtifactResetPaths } from "./seed-reset.ts";

/** Build the seam handle + neutral intent, then run the §4 finalize. */
export async function runProviderFinalize(ctx: ReapPipelineContext): Promise<FinalizeResult> {
	const handle: RunHandle = {
		runId: ctx.run.id,
		sandboxId: ctx.run.sandboxId as string, // non-null in the pipeline branch (reapRun guards it)
		providerRunId: ctx.run.sandboxRunId ?? "",
	};
	// Merges run unconditionally; COMMITS gate on project flags (warren-1f56).
	const commit: string[] = [];
	if (ctx.project.hasSeeds) commit.push("seeds");
	// warren-4e1c: mint the branch-push credential immediately before the
	// finalize spawn (forge-contract.md §4 — minted, never held on a config).
	// A mint failure is recorded and degrades to an anonymous push, which fails
	// closed as a `branch_push` stage failure on a private repo — rather than
	// skipping the merges wholesale.
	let gitCredential: GitSpawnCredential | undefined;
	if (ctx.input.forge !== undefined) {
		try {
			gitCredential = await mintGitCredential(ctx.input.forge, ctx.project.gitUrl);
		} catch (err) {
			await ctx.fail("branch_push", err);
		}
	}
	const intent: FinalizeIntent = {
		branch: ctx.branch ?? "",
		push: true,
		...(gitCredential !== undefined ? { gitCredential } : {}),
		// Opaque artifact keys the domain asks the provider to merge (warren-df3e);
		// the returned `FinalizeResult.artifacts` is keyed the same way.
		artifacts: ["mulch", "seeds", "plans"],
		commit,
		projectClonePathHint: ctx.project.localPath,
		// warren-8d95: reset warren-seeded artifacts to base before push so a broad
		// agent commit can't sweep them into the PR (Article IX protected-path guard).
		resetSeededPaths: seededArtifactResetPaths(ctx.run.renderedAgentJson),
		...(ctx.baseBranch !== null ? { baseBranch: ctx.baseBranch } : {}),
	};
	return ctx.provider.finalize(handle, intent);
}
