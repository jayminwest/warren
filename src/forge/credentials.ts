/**
 * Per-spawn git-credential mint (forge-contract.md §4 — the load-bearing
 * boundary: credentials are minted, never held).
 *
 * The HTTP handlers that fan a git credential into a domain call
 * (`addProject`, `refreshProject`, `spawnRun`, `createPlanRun`) mint HERE,
 * immediately before the call that spawns git, and pass the minted
 * {@link GitSpawnCredential} down the `gitCredential` params. Those params
 * feed `gitCredentialGitEnv` (src/workspace/git/credential-env.ts), which
 * renders the per-spawn `GIT_CONFIG_*` env, and the lifetime of one
 * git child is the credential's whole lifetime. Under PAT mode the mint is
 * a static read (free); under App mode this same call site is the re-mint
 * point.
 *
 * The mint returns the USERNAME and the HOST beside the secret
 * (warren-1b6f). Both used to be literals inside the env helper
 * (`x-access-token`, `github.com`), which made the rewrite a GitHub-only
 * rule: the username is the forge's own answer (`GitCredential.username`)
 * and the host belongs to the clone URL the forge was asked about.
 *
 * Callers pass the boot-resolved `Forge` (`ServerDeps.forge`, resolved once
 * by `resolveForge` in `src/server/main/index.ts`) — never a per-request
 * instance.
 */

import { WarrenError } from "../core/errors.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
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
 * Mint the credential for ONE git network op against `cloneUrl`.
 *
 * Returns `undefined`, meaning anonymous git, in three cases:
 *
 *   - the forge does not own the URL (`parseRepoRef` → null), matching the
 *     old behavior where the github.com-scoped `insteadOf` prefix never
 *     matched a foreign host;
 *   - the forge reports `no_credential` (e.g. `GITHUB_TOKEN` unset under
 *     PAT mode), matching the old undefined/empty-token passthrough;
 *   - the forge minted an empty secret or an empty username, neither of
 *     which can authenticate anything.
 *
 * Any other mint failure throws `GitCredentialMintError`.
 */
export async function mintGitCredential(
	forge: Forge,
	cloneUrl: string,
): Promise<GitSpawnCredential | undefined> {
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
	const { username, secret } = result.value;
	if (secret === "" || username === "") return undefined;
	// An empty host means no https remote to rewrite against, which is
	// FakeForge's `fake://owner/name` shape. The credential still exists and
	// still reaches the consumers that do not need a host (the in-pod
	// credential endpoint, `authenticatedCloneUrl`); only the `insteadOf`
	// rewrite renders nothing, exactly as the github.com-scoped rule did
	// against a foreign remote.
	return { username, secret, host: remoteHost(cloneUrl) ?? "" };
}

/**
 * The host an https rewrite would target, read off the clone URL rather
 * than out of `RepoRef`, which is provider-private and the domain never
 * destructures it (forge-contract.md §0). Handles the https, ssh and
 * scp-style spellings warren accepts. Returns null for anything else,
 * including a scheme with no authority such as FakeForge's
 * `fake://owner/name`, where an https rewrite would name nothing real.
 */
function remoteHost(cloneUrl: string): string | null {
	const trimmed = cloneUrl.trim();
	const scp = /^[^@\s/]+@([^:\s/]+):/.exec(trimmed);
	if (scp !== null) return (scp[1] as string).toLowerCase();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
		return null;
	}
	// `host`, not `hostname`: a self-hosted forge on a non-default port is a
	// different remote to git, and an `insteadOf` rule without the port would
	// never match the URL it is supposed to rewrite.
	const host = parsed.host.toLowerCase();
	return host === "" ? null : host;
}
