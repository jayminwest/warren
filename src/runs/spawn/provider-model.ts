/**
 * Rejects only provider/model pairs known to be incompatible (warren-bad5).
 *
 * Unknown providers, casing variants, and ambiguous model identifiers remain
 * valid because provider and model names are intentionally open-ended.
 */

import { ValidationError } from "../../core/errors.ts";

export function assertNoKnownProviderModelMismatch(
	provider: string | undefined,
	model: string | undefined,
): void {
	if (provider === undefined || model === undefined) return;

	const hasSlash = model.includes("/");
	const isSlashlessClaudeModel = !hasSlash && model.startsWith("claude-");
	const isMismatch =
		(provider === "openrouter" && isSlashlessClaudeModel) || (provider === "anthropic" && hasSlash);
	if (!isMismatch) return;

	const expectedShape =
		provider === "openrouter"
			? 'an OpenRouter model id in "vendor/model" form'
			: 'a slashless Anthropic model id such as "claude-opus-4-8"';
	throw new ValidationError(`model "${model}" is incompatible with provider "${provider}"`, {
		recoveryHint: `use ${expectedShape}, change the provider, or remove the incompatible provider/model setting`,
	});
}
