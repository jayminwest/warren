/**
 * Per-spawn git-credential mint (forge-contract.md §4.2 — the load-bearing
 * boundary: credentials are minted, never held).
 *
 * The HTTP handlers that fan a git credential into a domain call
 * (`addProject`, `refreshProject`, `spawnRun`, `createPlanRun`) mint HERE,
 * immediately before the call that spawns git, and pass only the minted
 * secret down the existing `token` / `githubToken` params. Those params
 * feed `githubCredentialGitEnv` (src/workspace/git/credential-env.ts),
 * which renders the per-spawn `GIT_CONFIG_*` env — the process lifetime of
 * one git child is the credential's whole lifetime. Under PAT mode the
 * mint is a static read (free); under App mode this same call site is the
 * re-mint point.
 *
 * Callers pass the boot-resolved `Forge` (`ServerDeps.forge`, resolved once
 * by `resolveForge` in `src/server/main/index.ts`) — never a per-request
 * instance.
 */

import { WarrenError } from "../core/errors.ts";
import type { Forge } from "./contract.ts";

/**
 * Thrown when a forge that OWNS the clone URL fails to mint a git
 * credential for a reason other than "no credential configured". A
 * misconfigured short-lived backend must fail loud, not silently degrade
 * to anonymous git against a private repo (which would surface as a
 * misleading git auth failure deep in the spawn).
 */
export class GitCredentialMintError extends WarrenError {
	readonly code = "forge_git_credential_mint_failed";
}

/**
 * Mint the secret for ONE git network op against `cloneUrl`.
 *
 * Returns `undefined` — anonymous git — in exactly the two cases the old
 * `AutoOpenPrConfig.gitToken` fan-out produced no credential:
 *
 *   - the forge does not own the URL (`parseRepoRef` → null), matching the
 *     old behavior where the github.com-scoped `insteadOf` prefix never
 *     matched a foreign host;
 *   - the forge reports `no_credential` (e.g. `GITHUB_TOKEN` unset under
 *     PAT mode), matching the old undefined/empty-token passthrough.
 *
 * Any other mint failure throws `GitCredentialMintError`.
 */
export async function mintGitCredentialSecret(
	forge: Forge,
	cloneUrl: string,
): Promise<string | undefined> {
	const ref = forge.parseRepoRef(cloneUrl);
	if (ref === null) return undefined;
	const result = await forge.gitCredential(ref);
	if (!result.ok) {
		if (result.error.kind === "no_credential") return undefined;
		throw new GitCredentialMintError(
			`forge "${ref.forge}" failed to mint a git credential: ${result.error.detail}`,
			{
				recoveryHint:
					"Check the forge credential configuration (GITHUB_TOKEN for WARREN_FORGE=github) and retry.",
			},
		);
	}
	return result.value.secret === "" ? undefined : result.value.secret;
}
