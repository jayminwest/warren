/**
 * Forge registry + the `WARREN_FORGE` selector (plan pl-d1c9 step 8,
 * forge-contract.md §1.1).
 *
 * One place resolves which `Forge` (contract in `./contract.ts`) a warren
 * process runs against, exactly once at boot — a deliberate mirror of the
 * runtime-provider precedent (`src/runtime/registry.ts`): same structure,
 * same failure mode. The default is `github` (`GitHubForge`, PAT/static
 * mode); `fake` (`FakeForge`) backs the campaign's falsification tests.
 *
 * Selection rules (§1.1):
 *   - `WARREN_FORGE` unset (or blank) → `github` (the default forge).
 *   - `github` → `GitHubForge` over the static secret, read from
 *     `WARREN_GIT_TOKEN` and then `GITHUB_TOKEN` (warren-1b6f: the same
 *     order the K8s pod path already reads, so one variable names the git
 *     credential whatever the forge is).
 *   - `app`    → `GitHubAppForge` (warren-f8df) over the
 *     `WARREN_GITHUB_APP_ID` / `WARREN_GITHUB_APP_INSTALLATION_ID` /
 *     `WARREN_GITHUB_APP_PRIVATE_KEY` triple; a missing or unparseable
 *     input throws `ForgeConfigError` at boot (fail loud, §4).
 *   - `ado`    → `AdoForge` (Azure DevOps Repos) over the personal access
 *     token in `WARREN_GIT_TOKEN`.
 *   - `fake`   → `FakeForge` with its in-memory PR store.
 *   - anything else → `UnknownForgeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong forge).
 *
 * Registry CONSTRUCTION only: threading the resolved instance through boot
 * wiring and `ServerDeps` is the next step (warren-6c4c). `parseRepoRef`
 * chaining operates over the boot-registered forges in their fixed
 * registration order (§1.1) — with one real forge registered, the chain
 * has length one.
 */

import { AdoForge } from "./ado/provider.ts";
import type { Forge } from "./contract.ts";
import { UnknownForgeError } from "./errors.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { FAKE_FORGE_STATE_FILE_ENV, FakeForgeStore } from "./fake/store.ts";
import { GitHubForge } from "./github/provider.ts";
import {
	type GitHubAppCredentials,
	GitHubAppForge,
	loadGitHubAppCredentialsFromEnv,
} from "./github-app/provider.ts";

/** Forge backends the selector understands. */
export type ForgeKind = "github" | "app" | "ado" | "fake";

/** Selector default when `WARREN_FORGE` is unset — the real forge. */
export const DEFAULT_FORGE_KIND: ForgeKind = "github";

/** Every recognized `WARREN_FORGE` value (used for validation + error hints). */
export const FORGE_KINDS: readonly ForgeKind[] = ["github", "app", "ado", "fake"];

/** Minimal env surface the selector reads. */
export type ForgeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every forge the registry can build is threaded. Kept as a
 * single bag — mirroring `RuntimeProviderDeps` — so adding a backend (the
 * `app` arm landed this way in warren-f8df) doesn't change the selector's
 * signature. The token, app credentials, and the fake's store are factories
 * so the registry needn't touch a secret or construct state for the arm it
 * did not select.
 */
export interface ForgeDeps {
	/**
	 * Lazy static-secret factory for the `github` arm. Optional — when
	 * omitted the selector reads `WARREN_GIT_TOKEN`, then `GITHUB_TOKEN`,
	 * from the same env the selection came from. A test injects a throwing
	 * factory here to prove the `fake` arm never touches the github arm's
	 * inputs.
	 */
	readonly githubToken?: () => string;
	/**
	 * OPTIONAL fetch seam for the `github` arm — a test injects a stub so
	 * the constructed `GitHubForge` never reaches the network.
	 */
	readonly githubFetch?: typeof fetch;
	/**
	 * OPTIONAL `capabilities.checkRuns` override for the `github` arm
	 * (forge-contract.md §5/§6.7): pass `false` when the configured token
	 * is a fine-grained PAT, which cannot reach the Checks API. Default
	 * true (classic PAT).
	 */
	readonly githubCheckRuns?: boolean;
	/**
	 * Lazy credential factory for the `app` arm (warren-f8df). Optional —
	 * when omitted the selector reads the `WARREN_GITHUB_APP_*` triple from
	 * the same env the selection came from. A test injects a throwing
	 * factory here to prove the other arms never touch the app arm's inputs.
	 */
	readonly githubApp?: () => GitHubAppCredentials;
	/**
	 * OPTIONAL fetch seam for the `app` arm — a test injects a stub so the
	 * constructed `GitHubAppForge` never reaches the network.
	 */
	readonly githubAppFetch?: typeof fetch;
	/**
	 * Lazy static-secret factory for the `ado` arm. Optional — when omitted
	 * the selector reads `WARREN_GIT_TOKEN` from the same env the selection
	 * came from. A test injects a throwing factory here to prove the other
	 * arms never touch the ado arm's inputs.
	 */
	readonly adoToken?: () => string;
	/**
	 * OPTIONAL fetch seam for the `ado` arm — a test injects a stub so the
	 * constructed `AdoForge` never reaches the network.
	 */
	readonly adoFetch?: typeof fetch;
	/**
	 * Lazy store factory for the `fake` arm — only consulted for
	 * `WARREN_FORGE=fake`. Optional: the `FakeForge` defaults to a fresh
	 * in-memory store. A test injects a throwing factory here to prove the
	 * `github` arm never constructs the fake's state.
	 */
	readonly fakeStore?: () => FakeForgeStore;
}

/**
 * Parse + validate the `WARREN_FORGE` selector. Blank/unset resolves to the
 * default; an unrecognized value throws `UnknownForgeError`.
 */
export function resolveForgeKind(env: ForgeEnv = process.env): ForgeKind {
	const raw = env.WARREN_FORGE?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_FORGE_KIND;
	}
	if ((FORGE_KINDS as readonly string[]).includes(raw)) {
		return raw as ForgeKind;
	}
	throw new UnknownForgeError(`Unknown WARREN_FORGE "${raw}"`, {
		recoveryHint: `Set WARREN_FORGE to one of: ${FORGE_KINDS.join(", ")} (or leave it unset for "${DEFAULT_FORGE_KIND}").`,
	});
}

/**
 * Resolve the forge for this process — call ONCE at boot. Selects on
 * `WARREN_FORGE` (see module doc) and constructs the chosen forge from
 * `deps`.
 */
/**
 * The first env token that carries something, trimmed.
 *
 * An operator who exports `WARREN_GIT_TOKEN=""` has not chosen a neutral
 * token, so an empty or blank value must not shadow a valid `GITHUB_TOKEN`
 * behind it. Same rule as `normalizeToken` in
 * `src/runtime/k8s/git-tokens.ts`, which the comment below claims parity with.
 */
function firstToken(...raw: readonly (string | undefined)[]): string {
	for (const value of raw) {
		const trimmed = value?.trim();
		if (trimmed !== undefined && trimmed !== "") return trimmed;
	}
	return "";
}

export function resolveForge(deps: ForgeDeps = {}, env: ForgeEnv = process.env): Forge {
	const kind = resolveForgeKind(env);
	switch (kind) {
		case "github": {
			// warren-1b6f: the forge-neutral name wins, and GITHUB_TOKEN stays as
			// the fallback, matching `src/runtime/k8s/git-tokens.ts`.
			const tokenFactory =
				deps.githubToken ?? (() => firstToken(env.WARREN_GIT_TOKEN, env.GITHUB_TOKEN));
			return new GitHubForge({
				token: tokenFactory(),
				...(deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {}),
				...(deps.githubCheckRuns !== undefined ? { checkRuns: deps.githubCheckRuns } : {}),
			});
		}
		case "app": {
			const credentials = (deps.githubApp ?? (() => loadGitHubAppCredentialsFromEnv(env)))();
			return new GitHubAppForge({
				...credentials,
				...(deps.githubAppFetch !== undefined ? { fetch: deps.githubAppFetch } : {}),
			});
		}
		case "ado":
			return buildAdoForge(deps, env);
		case "fake":
			return buildFakeForge(deps, env);
	}
}

function buildAdoForge(deps: ForgeDeps, env: ForgeEnv): Forge {
	const tokenFactory = deps.adoToken ?? (() => firstToken(env.WARREN_GIT_TOKEN));
	return new AdoForge({
		token: tokenFactory(),
		...(deps.adoFetch !== undefined ? { fetch: deps.adoFetch } : {}),
	});
}

function buildFakeForge(deps: ForgeDeps, env: ForgeEnv): Forge {
	if (deps.fakeStore !== undefined) {
		return new FakeForge({ store: deps.fakeStore() });
	}
	// Cross-process acceptance seam (warren-2600): the harness boots
	// warren as a subprocess, so it drives FakeForge state transitions
	// (markMerged & friends) by editing a JSON state file the store
	// reloads on every read. Unset → the pure in-memory store.
	const stateFile = env[FAKE_FORGE_STATE_FILE_ENV]?.trim();
	if (stateFile === undefined || stateFile === "") {
		return new FakeForge();
	}
	return new FakeForge({ store: new FakeForgeStore({ stateFile }) });
}
