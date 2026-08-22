/**
 * K8s git-credential resolution (forge-contract.md §4.1, warren-c9ac) —
 * extracted from `./provider.ts` (frozen size budget). Two of the three
 * token windows a >1h run must survive live here:
 *
 *   - **Window 1 (init-container clone):** `cloneTokenEnvOverlay` mints a
 *     FRESH credential at pod-spec time so a short-lived App-mode token is
 *     well inside its lifetime when the init container clones. The minted
 *     value rides `spec.env.WARREN_GIT_TOKEN` as a plain env var, which
 *     `./pod-env.ts` prefers over the static Secret ref for BOTH the init
 *     and agent containers — under App mode the pod never references the
 *     long-lived Secret at all.
 *   - **Window 2 (finalize push):** `resolveK8sPushToken` prefers the
 *     per-spawn minted `FinalizeIntent.gitToken` (warren-4e1c) and gates the
 *     static env fallback (`WARREN_GIT_TOKEN` / `GITHUB_TOKEN`) on
 *     `allowStaticEnv`. Under App mode that static value is exactly the
 *     hourly-expiring credential the campaign eliminates, so boot wires the
 *     gate OFF (`credentialLifetime: "short-lived"`) and an App-mode run
 *     NEVER depends on it — a missing mint fails the push closed rather
 *     than silently authenticating with a dead token.
 *
 * Window 3 (the pod-side salvage fallback) lives in `./salvage-post.ts`:
 * the pod re-mints over the authenticated callback instead of trusting the
 * mounted Secret.
 */

import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type { RunSpec } from "../contract.ts";

/** A blank/whitespace token is no token (matches the old `resolvePushToken`). */
function normalizeToken(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

/**
 * Mint the window-1 clone credential as a `spec.env` overlay. `{}` when no
 * mint seam is wired (PAT mode without a forge handle keeps the static
 * Secret ref), when the domain already pinned `WARREN_GIT_TOKEN` on the
 * spec, or when the mint yields anonymous git (foreign host / no_credential
 * (see `mintGitCredential`). A genuine App-mode mint failure THROWS
 * (`GitCredentialMintError`) so the dispatch fails loud instead of cloning
 * with a credential the run will outlive.
 */
export async function cloneTokenEnvOverlay(
	spec: RunSpec,
	mint: ((gitUrl: string) => Promise<string | undefined>) | undefined,
): Promise<Record<string, string>> {
	if (mint === undefined || spec.env.WARREN_GIT_TOKEN !== undefined) return {};
	const token = await mint(spec.originUrl);
	const normalized = normalizeToken(token);
	return normalized === undefined ? {} : { WARREN_GIT_TOKEN: normalized };
}

/**
 * Resolve the window-2 push credential for the in-pod finalize. Order:
 *
 *   1. the per-spawn minted intent token (the App-mode path — always present
 *      when the reap pipeline holds a forge);
 *   2. the static control-plane env (`WARREN_GIT_TOKEN`, then
 *      `GITHUB_TOKEN`), ONLY when `allowStaticEnv` — PAT/static mode, where
 *      the env value does not expire.
 *
 * Blank ⇒ `undefined` (public repos push anonymously, matching
 * `workspace-init`'s optional-token posture).
 */
export function resolveK8sPushToken(input: {
	readonly intentToken: string | undefined;
	readonly env: EnvLike;
	readonly allowStaticEnv: boolean;
}): string | undefined {
	const fromIntent = normalizeToken(input.intentToken);
	if (fromIntent !== undefined) return fromIntent;
	if (!input.allowStaticEnv) return undefined;
	return normalizeToken(input.env.WARREN_GIT_TOKEN) ?? normalizeToken(input.env.GITHUB_TOKEN);
}
