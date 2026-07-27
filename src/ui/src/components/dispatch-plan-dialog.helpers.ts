import type { CreatePlanRunInput } from "@/api/types.ts";

export const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

/**
 * The Dispatch button is enabled only when a registered agent, a plan id, and
 * a prompt template are all present, the project has `.seeds/`, and no dispatch
 * is already in flight.
 */
export function computeSubmittable(args: {
	isPending: boolean;
	hasSeeds: boolean;
	agent: string;
	planId: string;
	promptTemplate: string;
}): boolean {
	return (
		!args.isPending &&
		args.hasSeeds &&
		args.agent.length > 0 &&
		args.planId.trim().length > 0 &&
		args.promptTemplate.trim().length > 0
	);
}

/**
 * Build the `POST /plan-runs` payload from the dialog's field state. Provider /
 * model overrides are only included when set, matching the existing
 * `planRunsApi.create` contract.
 */
export function buildPlanRunInput(args: {
	projectId: string;
	planId: string;
	agent: string;
	promptTemplate: string;
	providerOverride: string;
	modelOverride: string;
}): CreatePlanRunInput {
	const trimmedProvider = args.providerOverride.trim();
	const trimmedModel = args.modelOverride.trim();
	return {
		project: args.projectId,
		planId: args.planId.trim(),
		agent: args.agent,
		promptTemplate: args.promptTemplate.trim(),
		...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
		...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
	};
}

/** Read agent frontmatter (provider/model auto-fill source) defensively. */
export function readFrontmatter(renderedJson: unknown): Record<string, unknown> {
	if (typeof renderedJson !== "object" || renderedJson === null) return {};
	const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
	if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return {};
	return fm as Record<string, unknown>;
}
