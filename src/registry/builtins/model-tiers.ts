/**
 * Centralized model tiers for the built-in agents.
 *
 * The literal model identifiers live here and nowhere else, so bumping a
 * model is a single edit (or a deploy-time env override) instead of a
 * hunt across every built-in. Each built-in spreads the tier it belongs
 * to into its frontmatter `provider` / `model` pair.
 *
 * Models churn fast, so defaults are overridable at deploy time via env
 * (set in docker-compose.yml / fly.toml) with no code change or image
 * rebuild:
 *
 *   WARREN_MODEL_OPUS            / WARREN_MODEL_OPUS_PROVIDER
 *   WARREN_MODEL_SONNET          / WARREN_MODEL_SONNET_PROVIDER
 *
 * Resolution happens at module load — set the env before warren boots and
 * the seed path (`seedBuiltinAgents`) freezes the resolved values onto
 * each agent row. `resolveModelTiers` is the pure core (takes an explicit
 * env bag) so it stays testable; `MODEL_TIERS` is the process-env-bound
 * singleton the built-ins import.
 */

export interface ModelTier {
	readonly provider: string;
	readonly model: string;
}

export interface ModelTiers {
	readonly opus: ModelTier;
	readonly sonnet: ModelTier;
}

function pick(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed !== "" ? trimmed : fallback;
}

export function resolveModelTiers(
	env: Record<string, string | undefined> = process.env,
): ModelTiers {
	return {
		opus: {
			provider: pick(env.WARREN_MODEL_OPUS_PROVIDER, "anthropic"),
			model: pick(env.WARREN_MODEL_OPUS, "claude-opus-4-8"),
		},
		sonnet: {
			provider: pick(env.WARREN_MODEL_SONNET_PROVIDER, "anthropic"),
			model: pick(env.WARREN_MODEL_SONNET, "claude-sonnet-4-6"),
		},
	};
}

export const MODEL_TIERS: ModelTiers = resolveModelTiers();
