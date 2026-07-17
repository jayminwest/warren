/**
 * warren-8d95: derive the warren-seeded "pure-context" artifact paths that reap
 * must reset to base before `branch_push` so they never ride into a PR.
 *
 * ## The bug
 *
 * Warren seeds the rendered agent envelope to `.canopy/agent.json` (plus `.pi/`
 * skill/prompt/extension drops and `.seeds/workflow.txt`). In a project that
 * itself TRACKS one of those paths — warren's own repo tracks
 * `.canopy/agent.json` — the seed overwrites a tracked file, leaving the
 * worktree dirty. A broad agent commit (`git add -A` / `git commit -a`) then
 * carries the seeded artifact into the run branch, and the auto-merge workflow's
 * Article IX protected-path guard (regex includes `^\.canopy/`) correctly
 * refuses to enable auto-merge, so the PR sits unmerged.
 *
 * ## The fix
 *
 * Reconstruct the exact bytes warren seeded (via {@link buildSeedFiles} over the
 * run's stored `renderedAgentJson`) for the pure-context drops ONLY — the
 * mirror-managed `.mulch/expertise/` family is left to finalize's mulch merge —
 * and hand them to `provider.finalize` as `intent.resetSeededPaths`. finalize
 * resets each path to `baseBranch` iff the live workspace content still equals
 * the seeded bytes (an intentional agent edit is preserved untouched).
 */

import type { AgentDefinition } from "../../registry/schema.ts";
import { buildSeedFiles } from "../seed.ts";

/** One warren-seeded artifact path with the exact bytes warren wrote. */
export interface SeededResetPath {
	readonly path: string;
	readonly contents: string;
}

/**
 * Rebuild the warren-seeded artifact list from the run's stored agent envelope
 * and return the PURE-CONTEXT drops (canopy + `.pi/**` + `.seeds/workflow.txt`),
 * excluding the mirror-managed `.mulch/expertise/` family. Defensive: a missing
 * or malformed `renderedAgentJson` (or a seed builder throw) yields `[]` so reap
 * degrades to its pre-warren-8d95 behavior rather than failing the run.
 */
export function seededArtifactResetPaths(renderedAgentJson: unknown): SeededResetPath[] {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return [];
	let files: ReadonlyArray<{ path: string; contents: string }>;
	try {
		files = buildSeedFiles(renderedAgentJson as AgentDefinition).files;
	} catch {
		return [];
	}
	return files
		.filter((f) => !f.path.startsWith(".mulch/"))
		.map((f) => ({ path: f.path, contents: f.contents }));
}
