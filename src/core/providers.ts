/**
 * Canonical provider → env-key registry (warren-fb8d).
 *
 * Wire vocabulary consumed here (RunCostBasis) comes from ./wire.ts —
 * `src/core/` imports only itself.
 */
import type { RunCostBasis } from "./wire.ts";

/**
 * Canonical provider → env-key registry (warren-fb8d).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for which environment variables a
 * model provider authenticates with. Before it existed, the knowledge was
 * hardcoded per-topology with DISJOINT provider sets: the K8s pod-spec
 * builder hand-wrote secretKeyRefs for `anthropic` + `openrouter` only,
 * while the local topology inherited whatever burrow's
 * `PI_PROVIDER_ENV_KEYS` forwarded — so dispatch accepted providers the
 * selected topology could not authenticate, and the run died at auth inside
 * the sandbox.
 *
 * Following the `src/core/wire.ts` pattern: `src/core/` imports nothing, so
 * every layer (the runtime providers, dispatch-time validation, the UI)
 * can import this registry without inheriting a dependency. RuntimeProvider
 * implementations consume it to DELIVER an opaque set of key/value pairs
 * they do not interpret:
 *
 *   - `K8sProvider` maps each provider's canonical env key to an optional
 *     secretKeyRef (`warren-<provider>-key` / `api-key`, overridable per
 *     provider) — generically, with no per-provider code blocks.
 *   - `LocalProvider` (and the DockerProvider, which shares the local
 *     profile builder) forwards the registry-derived key set for the run's
 *     `frontmatter.provider` via `PI_PROVIDER_ENV_KEYS` in
 *     `src/runtime/local/profile.ts` — that table is DERIVED from this
 *     registry since warren-81e0, so the sandbox allowlist can never lag
 *     the dispatch-time provider vocabulary again.
 *
 * A provider name absent from the registry is UNKNOWN, not invalid — the
 * provider vocabulary is intentionally open-ended (custom gateways, new pi
 * providers). Unknown names simply contribute no env keys.
 */

/** Env-key set for one provider. */
export interface ProviderEnvRegistration {
	/**
	 * Credential env keys the provider authenticates with, in priority order.
	 * `envKeys[0]` is the CANONICAL key — the one a runtime maps to a
	 * secretKeyRef / requires to consider the provider authenticated.
	 */
	readonly envKeys: readonly string[];
	/**
	 * Extra keys forwarded when present but not required to authenticate
	 * (base-URL overrides, alternate OAuth tokens). Never secret-mapped.
	 */
	readonly optionalEnvKeys: readonly string[];
}

/**
 * The registry. Keyed by the provider name as it reaches pi's `--provider`
 * flag. Frozen; membership is tested via {@link isKnownProviderName}, never
 * by rebuilding a key set at a call site.
 */
export const PROVIDER_ENV_REGISTRY = {
	anthropic: {
		envKeys: ["ANTHROPIC_API_KEY"],
		optionalEnvKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"],
	},
	openrouter: {
		envKeys: ["OPENROUTER_API_KEY"],
		optionalEnvKeys: ["OPENROUTER_BASE_URL"],
	},
	openai: {
		envKeys: ["OPENAI_API_KEY"],
		optionalEnvKeys: ["OPENAI_BASE_URL"],
	},
	google: {
		envKeys: ["GEMINI_API_KEY"],
		optionalEnvKeys: ["GOOGLE_API_KEY"],
	},
	groq: { envKeys: ["GROQ_API_KEY"], optionalEnvKeys: [] },
	mistral: { envKeys: ["MISTRAL_API_KEY"], optionalEnvKeys: [] },
	deepseek: { envKeys: ["DEEPSEEK_API_KEY"], optionalEnvKeys: [] },
	zai: { envKeys: ["ZAI_API_KEY"], optionalEnvKeys: [] },
	"opencode-go": {
		envKeys: ["OPENCODE_API_KEY"],
		optionalEnvKeys: [],
	},
} as const satisfies Record<string, ProviderEnvRegistration>;

/** A provider name the registry knows. */
export type KnownProviderName = keyof typeof PROVIDER_ENV_REGISTRY;

/** Frozen name list, in registry declaration order. */
export const KNOWN_PROVIDER_NAMES: readonly KnownProviderName[] = Object.freeze(
	Object.keys(PROVIDER_ENV_REGISTRY) as KnownProviderName[],
);

/** Membership predicate for {@link KNOWN_PROVIDER_NAMES}. */
export function isKnownProviderName(value: unknown): value is KnownProviderName {
	return typeof value === "string" && Object.hasOwn(PROVIDER_ENV_REGISTRY, value);
}

/**
 * Resolve a free-form provider string to its canonical registry name
 * (trimmed, lowercased). `undefined` means outside the registry — an
 * unknown provider, which is legal (the vocabulary is open-ended) but
 * contributes no env keys.
 */
export function normalizeProviderName(value: string): KnownProviderName | undefined {
	const normalized = value.trim().toLowerCase();
	return isKnownProviderName(normalized) ? normalized : undefined;
}

/** The registry entry for a provider name, or `undefined` when unknown. */
export function providerEnvRegistration(name: string): ProviderEnvRegistration | undefined {
	const canonical = normalizeProviderName(name);
	return canonical === undefined ? undefined : PROVIDER_ENV_REGISTRY[canonical];
}

/**
 * The canonical credential env key for a provider (`envKeys[0]`), or
 * `undefined` when the provider is unknown to the registry.
 */
export function primaryProviderEnvKey(name: string): string | undefined {
	return providerEnvRegistration(name)?.envKeys[0];
}

/**
 * Collect every registry env key (required + optional, across ALL known
 * providers) present in `env` into one opaque key/value delivery set. This
 * is the RuntimeProvider's delivery primitive: the caller does not know
 * which provider a run will use, and does not need to — it delivers every
 * credential it holds and the agent's runtime picks what it recognizes.
 * Blank values are skipped. Unknown provider keys never appear here.
 */
export function collectProviderEnv(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const provider of KNOWN_PROVIDER_NAMES) {
		const registration = PROVIDER_ENV_REGISTRY[provider];
		for (const key of [...registration.envKeys, ...registration.optionalEnvKeys]) {
			const value = env[key];
			if (value !== undefined && value !== "") out[key] = value;
		}
	}
	return out;
}

/**
 * Cost-basis detection (warren-f3c3 / pl-26f3 step 5), beside the provider
 * env resolution it reads. A run whose anthropic credential resolves from
 * `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription grant) with no
 * `ANTHROPIC_API_KEY` present is priced on subscription, so its `costUsd`
 * is an API-priced ESTIMATE, not a bill → `subscription_estimate`.
 * Everything else — API-key runs, non-anthropic providers, both keys
 * present (the API key wins in the harness) — is `api`.
 *
 * `provider` is the DECLARED frontmatter provider (after the override
 * chain). An undeclared provider defaults to anthropic's shape: both
 * shipped runtimes (claude-code, pi) authenticate against anthropic unless
 * the frontmatter says otherwise.
 */
export function resolveRunCostBasis(
	provider: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
): RunCostBasis {
	const anthropicShaped = provider === undefined || normalizeProviderName(provider) === "anthropic";
	if (!anthropicShaped) return "api";
	const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;
	const apiKey = env.ANTHROPIC_API_KEY;
	const hasOauth = oauth !== undefined && oauth !== "";
	const hasApiKey = apiKey !== undefined && apiKey !== "";
	return hasOauth && !hasApiKey ? "subscription_estimate" : "api";
}
