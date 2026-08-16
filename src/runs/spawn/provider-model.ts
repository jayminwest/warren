/**
 * Rejects only provider/model pairs known to be incompatible (warren-bad5).
 *
 * Unknown providers and ambiguous model identifiers remain valid because
 * provider and model names are intentionally open-ended. Known provider
 * names are normalized through the core registry (warren-fb8d) first, so a
 * casing variant of a registered provider hits the same checks.
 */

import { ValidationError } from "../../core/errors.ts";
import { normalizeProviderName } from "../../core/providers.ts";

export function assertNoKnownProviderModelMismatch(
	provider: string | undefined,
	model: string | undefined,
): void {
	if (provider === undefined || model === undefined) return;

	// warren-fb8d: consult the core provider registry so casing variants of a
	// KNOWN provider ("OpenRouter") hit the same incompatibility checks as the
	// canonical spelling. Unknown providers stay open-ended and unchecked.
	const canonical = normalizeProviderName(provider) ?? provider;

	const hasSlash = model.includes("/");
	const isSlashlessClaudeModel = !hasSlash && model.startsWith("claude-");
	const isMismatch =
		(canonical === "openrouter" && isSlashlessClaudeModel) ||
		(canonical === "anthropic" && hasSlash);
	if (!isMismatch) return;

	const expectedShape =
		canonical === "openrouter"
			? 'an OpenRouter model id in "vendor/model" form'
			: 'a slashless Anthropic model id such as "claude-opus-4-8"';
	throw new ValidationError(`model "${model}" is incompatible with provider "${provider}"`, {
		recoveryHint: `use ${expectedShape}, change the provider, or remove the incompatible provider/model setting`,
	});
}
