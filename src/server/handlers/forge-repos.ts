/**
 * Forge repo listing handler (warren-2601 / pl-26f3 step 10) —
 * `GET /forge/repos`.
 *
 * The Add Project surface's data source: when the active forge credential
 * is installation-scoped (the GitHub App forge), the picker needs the
 * installation's repositories. Everything forge-transport stays behind the
 * boot-resolved `Forge` seam (`deps.forge`); this handler is a thin surface
 * over `Forge.listInstallationRepos`, following the capability-flag branch
 * the IssueTracker seam uses — a PAT or absent forge gets a 200 with
 * `supported: false` and an empty list rather than an error, so the UI
 * branches on one discriminant and always keeps the URL-paste fallback.
 */

import type { ForgeRepoListing } from "../../forge/contract.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

/** The `GET /forge/repos` envelope. `supported` is the picker's discriminant. */
export interface ForgeReposResponse {
	readonly supported: boolean;
	readonly repos: readonly ForgeRepoListing[];
}

export type { ForgeRepoListing };

/**
 * `GET /forge/repos` — repositories visible to the active forge credential.
 *
 * Policy is `readOperator`: the body names private repositories the App
 * installation can reach, which a public spectator must not see. A
 * transport failure while listing degrades to `supported: false` (the URL
 * paste path stays usable) — a picker is an enhancement, never a gate.
 */
export function forgeReposHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		if (!deps.forge.capabilities.installationRepos) {
			return jsonResponse(200, { supported: false, repos: [] } satisfies ForgeReposResponse);
		}
		const result = await deps.forge.listInstallationRepos();
		if (!result.ok) {
			// Degrade, not fail: the dialog falls back to the URL paste with
			// the forge's redacted detail shown inline.
			return jsonResponse(200, {
				supported: false,
				repos: [],
				error: result.error.detail,
			} satisfies ForgeReposResponse & {
				error: string;
			});
		}
		return jsonResponse(200, { supported: true, repos: result.value } satisfies ForgeReposResponse);
	};
}
