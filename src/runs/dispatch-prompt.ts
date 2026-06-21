/**
 * Dispatch-prompt builder (warren-92dd / pl-fb43 step 4).
 *
 * Shared by the plan-run coordinator (src/plan-runs/coordinator.ts) and the
 * single-run dispatch path (POST /runs) to render the prompt template a child
 * executor receives. Two template tokens are supported:
 *
 *   - `{seed_id}`   — the seed identifier (e.g. `warren-92dd`)
 *   - `{seed_body}` — the resolved seed title + description, inlined so a
 *                     cross-repo executor needs no in-workspace `.seeds/`
 *                     access to read the issue text.
 *
 * Cross-repo auto-inject: when the seed lives in a *different* project than
 * the one cloned into the execution workspace (`crossRepo === true`), the
 * resolved title+body is appended to the rendered prompt even if the template
 * only references `{seed_id}`. This guarantees the executor always receives
 * the issue text directly. When the projects match (`crossRepo === false`,
 * the default), `{seed_id}`-only behaviour is byte-identical to the legacy
 * `template.replace(/\{seed_id\}/g, seedId)`.
 */

export interface DispatchPromptSeed {
	readonly id: string;
	/** Seed title, as returned by `sd show --json`. */
	readonly title?: string;
	/** Seed description/body, as returned by `sd show --json`. */
	readonly body?: string;
}

export interface BuildDispatchPromptInput {
	readonly template: string;
	readonly seed: DispatchPromptSeed;
	/**
	 * True when the seed's home project differs from the execution project
	 * (seedProjectId !== execution projectId). Drives the auto-inject of the
	 * seed text when the template only references `{seed_id}`.
	 */
	readonly crossRepo?: boolean;
}

const SEED_ID_TOKEN = /\{seed_id\}/g;
const SEED_BODY_TOKEN = /\{seed_body\}/g;

/**
 * Compose the seed title + body into a single block. Title and body are each
 * trimmed; whichever are present are joined by a blank line. Returns `""` when
 * neither is present.
 */
export function formatSeedContent(seed: DispatchPromptSeed): string {
	const title = seed.title?.trim() ?? "";
	const body = seed.body?.trim() ?? "";
	if (title.length > 0 && body.length > 0) return `${title}\n\n${body}`;
	return title.length > 0 ? title : body;
}

function injectionBlock(seed: DispatchPromptSeed): string {
	const content = formatSeedContent(seed);
	return [
		`The issue text for ${seed.id} is included below because it lives in a`,
		"different repository than this workspace, so `.seeds/` is not available",
		"here:",
		"",
		content,
	].join("\n");
}

/**
 * Render the dispatch prompt for a child executor. See module docstring for
 * the token + cross-repo-inject contract.
 */
export function buildDispatchPrompt(input: BuildDispatchPromptInput): string {
	const { template, seed, crossRepo = false } = input;
	const referencesBody = SEED_BODY_TOKEN.test(template);
	// Reset lastIndex — SEED_BODY_TOKEN is a /g regex and `.test()` advances it.
	SEED_BODY_TOKEN.lastIndex = 0;
	const seedContent = formatSeedContent(seed);
	const rendered = template.replace(SEED_ID_TOKEN, seed.id).replace(SEED_BODY_TOKEN, seedContent);
	if (crossRepo && !referencesBody && seedContent.length > 0) {
		return `${rendered}\n\n${injectionBlock(seed)}`;
	}
	return rendered;
}
