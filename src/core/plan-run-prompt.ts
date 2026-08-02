/**
 * Plan-run prompt-template vocabulary (warren-b3be).
 *
 * A plan-run renders one prompt per child seed by substituting the
 * `{seed_id}` placeholder. A template without the placeholder dispatches
 * every child with the same prompt and no seed reference, so the
 * placeholder is a hard requirement on operator-supplied templates.
 *
 * This module lives in the dependency-free kernel so the db default, the
 * coordinator's renderer, the HTTP validation and the UI's placeholder
 * text all read the same three values. It imports only `./errors.ts`.
 */

import { ValidationError } from "./errors.ts";

/** The one placeholder a plan-run prompt template must contain. */
export const SEED_ID_PLACEHOLDER = "{seed_id}";

/** The template used when `POST /plan-runs` omits `promptTemplate`. */
export const DEFAULT_PLAN_RUN_PROMPT_TEMPLATE = "work on sd {seed_id}";

/** True when `template` carries at least one `{seed_id}` placeholder. */
export function hasSeedIdPlaceholder(template: string): boolean {
	return template.includes(SEED_ID_PLACEHOLDER);
}

/**
 * Throw `ValidationError` unless `template` contains `{seed_id}`. Called on
 * the operator-supplied value only; the default already satisfies it.
 */
export function assertPlanRunPromptTemplate(template: string): void {
	if (hasSeedIdPlaceholder(template)) return;
	throw new ValidationError(
		`promptTemplate must contain at least one ${SEED_ID_PLACEHOLDER} placeholder; ` +
			"without it every child of the plan is dispatched with an identical prompt " +
			"and no seed reference",
		{
			recoveryHint: `include ${SEED_ID_PLACEHOLDER} in the template, e.g. '${DEFAULT_PLAN_RUN_PROMPT_TEMPLATE}', or omit promptTemplate to use the default`,
		},
	);
}

/**
 * Render a plan-run prompt for one child seed. Every occurrence of the
 * placeholder is substituted — a single-replace here silently left later
 * occurrences unsubstituted.
 */
export function renderPlanRunPrompt(template: string, seedId: string): string {
	return template.replaceAll(SEED_ID_PLACEHOLDER, seedId);
}
