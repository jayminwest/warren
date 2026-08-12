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
 *   - `github` → `GitHubForge` over the static `GITHUB_TOKEN` secret.
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

import type { Forge } from "./contract.ts";
import { UnknownForgeError } from "./errors.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import type { FakeForgeStore } from "./fake/store.ts";
import { GitHubForge } from "./github/provider.ts";

/** Forge backends the selector understands. */
export type ForgeKind = "github" | "fake";

/** Selector default when `WARREN_FORGE` is unset — the real forge. */
export const DEFAULT_FORGE_KIND: ForgeKind = "github";

/** Every recognized `WARREN_FORGE` value (used for validation + error hints). */
export const FORGE_KINDS: readonly ForgeKind[] = ["github", "fake"];

/** Minimal env surface the selector reads. */
export type ForgeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every forge the registry can build is threaded. Kept as a
 * single bag — mirroring `RuntimeProviderDeps` — so adding a backend later
 * (GitHub App mode) doesn't change the selector's signature. The token and
 * the fake's store are factories so the registry needn't touch a secret or
 * construct state for the arm it did not select.
 */
export interface ForgeDeps {
	/**
	 * Lazy static-secret factory for the `github` arm. Optional — when
	 * omitted the selector reads `GITHUB_TOKEN` from the same env the
	 * selection came from. A test injects a throwing factory here to prove
	 * the `fake` arm never touches the github arm's inputs.
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
export function resolveForge(deps: ForgeDeps = {}, env: ForgeEnv = process.env): Forge {
	const kind = resolveForgeKind(env);
	switch (kind) {
		case "github": {
			const tokenFactory = deps.githubToken ?? (() => env.GITHUB_TOKEN ?? "");
			return new GitHubForge({
				token: tokenFactory(),
				...(deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {}),
				...(deps.githubCheckRuns !== undefined ? { checkRuns: deps.githubCheckRuns } : {}),
			});
		}
		case "fake":
			return new FakeForge(deps.fakeStore !== undefined ? { store: deps.fakeStore() } : {});
	}
}
