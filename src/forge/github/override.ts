/**
 * Acceptance test seam (warren-ae00 / scenario 26), now living at the forge
 * transport layer (warren-45e6): when `WARREN_GH_FETCH_OVERRIDE=merged` is
 * set, GitHub REST call sites that opt in short-circuit to a canned positive
 * response — `GitHubForge.openPullRequest` returns a synthetic `pull/1` ref
 * and `checkPullRequestMerged` (`src/runs/pr-checks.ts`, pre-migration)
 * returns `merged` immediately. Lets the in-proc plan-run roundtrip exercise
 * reap's PR open + the coordinator's pr_open → merged transition without
 * standing up a real GitHub fixture. Unset in production deployments.
 *
 * The reader lives HERE, inside the forge's GitHub transport, because the
 * seam stubs a GitHub wire call — domain code re-exports the symbols
 * (`src/runs/pr-checks.ts`) rather than owning a second copy.
 */

export const GH_FETCH_OVERRIDE_ENV = "WARREN_GH_FETCH_OVERRIDE";

export function readGhFetchOverride(): "merged" | null {
	const v = process.env[GH_FETCH_OVERRIDE_ENV];
	if (typeof v !== "string") return null;
	return v.trim() === "merged" ? "merged" : null;
}
