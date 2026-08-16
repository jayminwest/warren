/**
 * Agent git-identity env helpers for the dispatch path (warren-4e36,
 * warren-e7b7). Extracted from `dispatch.ts` to keep that file under the
 * per-file size budget (warren-4553).
 */

import { resolveRuntimeKind } from "../../runtime/registry.ts";
import type { EnvLike } from "./callback-env.ts";
import type { SpawnLogger } from "./types.ts";

/** Both halves or nothing — mirrors the supervisor's rule (warren-4e36). */
function readGitIdentity(serverEnv: EnvLike): { name: string; email: string } | undefined {
	const name = serverEnv.WARREN_GIT_AUTHOR_NAME?.trim();
	const email = serverEnv.WARREN_GIT_AUTHOR_EMAIL?.trim();
	if (name === undefined || name === "" || email === undefined || email === "") {
		return undefined;
	}
	return { name, email };
}

/**
 * Forward the operator's agent-commit identity (`WARREN_GIT_AUTHOR_NAME` /
 * `WARREN_GIT_AUTHOR_EMAIL`, see `.env.example`) into the sandbox as the four
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars git reads ahead of any config.
 *
 * On the Local path the supervisor already exports these into its own process
 * env (`src/supervisor/git-identity.ts`) and burrow passes them through, so
 * this is a no-op re-assertion of the same values. On the K8s path there is NO
 * supervisor and the run pod has no gitconfig at all — without this every
 * agent `git commit` dies with "Author identity unknown" exit 128 (hit live on
 * GKE, warren-4e36). Mirrors the supervisor's rule: both halves or nothing.
 */
export function injectGitIdentityEnv(env: Record<string, string>, serverEnv: EnvLike): void {
	const identity = readGitIdentity(serverEnv);
	if (identity === undefined) return;
	env.GIT_AUTHOR_NAME = identity.name;
	env.GIT_AUTHOR_EMAIL = identity.email;
	env.GIT_COMMITTER_NAME = identity.name;
	env.GIT_COMMITTER_EMAIL = identity.email;
}

/**
 * warren-e7b7: warn once per dispatch when the K8s topology runs without
 * `WARREN_GIT_AUTHOR_NAME` / `WARREN_GIT_AUTHOR_EMAIL` configured. The
 * Local topology already gets the supervisor's loud warn fallback
 * (`src/supervisor/git-identity.ts`, warren-6a28), so this fires only when
 * `resolveRuntimeKind` says k8s — the pod boundary has no supervisor, no
 * gitconfig, and no other operator-facing signal.
 */
export function warnIfGitIdentityUnconfigured(log: SpawnLogger, serverEnv: EnvLike): void {
	if (resolveRuntimeKind(serverEnv) !== "k8s") return;
	if (readGitIdentity(serverEnv) !== undefined) return;
	log.warn(
		{ event: "spawn.git_identity_unconfigured" },
		"dispatching without WARREN_GIT_AUTHOR_NAME/WARREN_GIT_AUTHOR_EMAIL — agent commits attribute to the pod's fallback git identity; set both vars to a dedicated machine-account noreply address",
	);
}
