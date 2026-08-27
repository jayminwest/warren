/**
 * Boot wiring for the opt-in GitHub App credential store and hot forge
 * activation (warren-b504, plan pl-26f3 step 7).
 *
 * Resolves ONCE at boot, exactly like the forge itself (warren-6c4c) and
 * the registration gate (warren-e320):
 *
 *   - `WARREN_APP_CRED_STORE` unset/blank (the default) → the store is
 *     NOT armed: the historical render-once flow, byte-identical, and
 *     the boot forge is resolved exactly as before (no wrapper).
 *   - `WARREN_APP_CRED_STORE=data-dir` → the store is armed:
 *       - a complete stored triple is PREFERRED over the default PAT
 *         forge whenever the `WARREN_GITHUB_APP_*` env vars are absent,
 *         so restarts keep App mode without operator action;
 *       - the resolved forge is wrapped in `HotForge` and threaded
 *         everywhere the boot forge goes, so the `/github-app/installed`
 *         return route can activate the App forge in-process.
 *
 * Explicit env config always wins over the store: `WARREN_FORGE=github`
 * or `=fake` selects its forge even with a stored triple (the operator
 * chose), and a set `WARREN_GITHUB_APP_ID` names its own credentials.
 * An unrecognized store value or a public-auth combination throws at
 * boot (`ValidationError`) — fail loud, never silently default.
 *
 * Extracted from `bootServer` (which sits at its per-file size budget).
 */

import { join } from "node:path";
import type { Forge } from "../../forge/contract.ts";
import {
	GITHUB_APP_CREDENTIAL_FILE,
	GitHubAppCredentialStore,
	isCompleteCredential,
	resolveAppCredStoreEnabled,
} from "../../forge/github-app/credential-store.ts";
import { GitHubAppForge } from "../../forge/github-app/provider.ts";
import { type GitHubAppActivation, HotForge } from "../../forge/hot-forge.ts";
import { resolveForge } from "../../forge/registry.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";

export interface GitHubAppActivationBootInput {
	readonly env: EnvLike;
	readonly dataDir: string;
	readonly logger: Logger;
}

export interface GitHubAppActivationBootResult {
	/** The forge to thread through boot — `HotForge` when armed. */
	readonly forge: Forge;
	/** The activation seam for the `/github-app/*` handlers; absent when not armed. */
	readonly activation: GitHubAppActivation | undefined;
}

/**
 * Resolve the forge + optional activation seam for this process. Call
 * ONCE at boot, where `resolveForge` used to be called directly.
 */
export function bootGitHubAppActivation(
	input: GitHubAppActivationBootInput,
): GitHubAppActivationBootResult {
	const { env, dataDir, logger } = input;
	if (!resolveAppCredStoreEnabled(env)) {
		return { forge: resolveForge({}, env), activation: undefined };
	}

	const store = new GitHubAppCredentialStore(join(dataDir, GITHUB_APP_CREDENTIAL_FILE));
	const stored = store.read();
	const envHasAppId = (env.WARREN_GITHUB_APP_ID ?? "").trim() !== "";

	// Boot preference for the stored triple: only when the env vars are
	// absent AND the operator didn't deliberately select another forge
	// (an explicit `WARREN_FORGE=github`/`=fake` wins; unset or `=app`
	// prefers the store). `kind === "app"` with absent env vars would
	// fail boot in `resolveForge`'s default factory — the stored triple
	// rescues it.
	const explicitForge = (env.WARREN_FORGE ?? "").trim();
	const preferStored =
		stored !== null &&
		isCompleteCredential(stored) &&
		!envHasAppId &&
		(explicitForge === "" || explicitForge === "app");

	const boot =
		preferStored && stored !== null
			? resolveForge(
					{
						githubApp: () => ({
							appId: stored.appId,
							installationId: stored.installationId ?? "",
							privateKey: stored.privateKey,
						}),
					},
					{ ...env, WARREN_FORGE: "app" },
				)
			: resolveForge({}, env);

	const hotForge = new HotForge(boot);
	logger.info(
		{
			path: store.path,
			...(stored !== null ? { storedAppId: stored.appId } : {}),
			activated: boot instanceof GitHubAppForge,
		},
		"github app credential store armed (WARREN_APP_CRED_STORE=data-dir)",
	);
	return { forge: hotForge, activation: { store, hotForge } };
}
