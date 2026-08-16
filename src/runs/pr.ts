import {
	composeBody,
	composeTitle,
	type PrFragmentContext,
	type PrTemplateOverrides,
} from "./pr-template.ts";

export { PR_URL_RE, parsePullRequestUrl } from "./pr-checks.ts";

/**
 * PR title/body composition + the auto-open config for the reap pipeline.
 *
 * warren-45e6 (plan pl-d1c9 step 10): the direct GitHub REST client that
 * used to live here (`openPullRequest` over `POST /repos/:o/:r/pulls`) is
 * gone — PR creation now crosses the Forge seam (`forge.openPullRequest`,
 * driven by `src/runs/reap/pr-open.ts`). What remains is DOMAIN meaning
 * (forge-contract.md §3): the template-driven title/body composer and the
 * `WARREN_AUTO_OPEN_PR` env config.
 *
 * The body and title format is template-driven (warren-bd49): the body
 * comes from the named-fragment registry in `src/runs/pr-template.ts`,
 * and projects override individual fragments via
 * `.warren/pr-template.md`. Title follows the same registry: a project
 * `title` override wins; otherwise the seed/commit/prompt precedence
 * chain applies.
 */

/* ----------------------------------------------------------------------- */
/* Title + body formatting                                                  */
/* ----------------------------------------------------------------------- */

const TITLE_MAX_LENGTH = 72;

export interface PrCommit {
	readonly sha: string;
	readonly subject: string;
}

export interface PrSeed {
	readonly id: string;
	readonly title: string;
}

export interface BuildPrContentInput {
	readonly prompt: string;
	readonly runId: string;
	readonly agentName: string;
	/** Optional warren UI base URL (e.g. `https://warren.example.com`). */
	readonly warrenBaseUrl?: string;
	/** Commits ahead of the base branch, oldest-first. */
	readonly commits?: readonly PrCommit[];
	/** Raw `git diff --stat <base>..HEAD` output (multi-line). */
	readonly diffStat?: string;
	/** Resolved seed referenced by the prompt (best-effort `sd show`). */
	readonly seed?: PrSeed;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly costUsd?: number;
	readonly tokensInput?: number;
	readonly tokensOutput?: number;
	readonly tokensCacheRead?: number;
	/**
	 * Project opted into per-run preview environments (R-19 / docs/design/preview-environments.md).
	 * When true, the body includes a `preview_url_or_placeholder` fragment
	 * (a `## Preview` section bracketed by `<!-- warren:preview-start -->`
	 * and `<!-- warren:preview-end -->`) so reap's `pr_annotate_preview`
	 * sub-step can patch in the live URL once the sidecar is ready. False /
	 * absent renders no fragment — non-opted-in projects don't see preview
	 * scaffolding in their PR body.
	 */
	readonly previewOptedIn?: boolean;
	/**
	 * Body (not the subject) of the run's final commit, lifted at reap into
	 * an `## Agent notes` section under Summary (warren-5e86). Empty or
	 * absent → no section.
	 */
	readonly agentNotes?: string;
	/**
	 * Per-project PR-template overrides (warren-bd49). Loaded from
	 * `.warren/pr-template.md` by `loadPrTemplate` and threaded through
	 * `reapRun`. Each key is a fragment name from `PR_FRAGMENT_NAMES`
	 * (`src/runs/pr-template.ts`); the value replaces the default body
	 * for that fragment. Whitespace-only values remove the fragment
	 * from the output. Omitted / undefined → defaults apply.
	 */
	readonly templateOverrides?: PrTemplateOverrides;
}

/**
 * Markers `pr_annotate_preview` looks for when patching the live URL or
 * failure tail into the PR body (warren-f156). Exported so the annotator
 * can match without duplicating the literal — drift between the two
 * sides would silently break idempotency.
 */
export const PREVIEW_FRAGMENT_START = "<!-- warren:preview-start -->" as const;
export const PREVIEW_FRAGMENT_END = "<!-- warren:preview-end -->" as const;

export interface PrContent {
	readonly title: string;
	readonly body: string;
}

/**
 * Build the PR title and body (warren-9ee3).
 *
 * Body is composed from named fragments via the registry in
 * `src/runs/pr-template.ts` (warren-bd49); project overrides from
 * `.warren/pr-template.md` thread through `input.templateOverrides`
 * and replace individual fragments by name.
 *
 * Title precedence — first non-empty wins:
 *   1. Project `title` override (when supplied via templateOverrides).
 *   2. Resolved seed title (`seed.title`) when the prompt referenced a seed.
 *   3. First commit subject on the branch.
 *   4. First non-empty line of the prompt.
 *   5. `warren run <id> (<agent>)` fallback for empty prompts.
 *
 * Body fragments (in order, omitted when their data is absent and
 * the project hasn't overridden):
 *   - summary, run, seeds, preview_url_or_placeholder, commits,
 *     files_changed, prompt, trailer
 */
export function buildPrContent(input: BuildPrContentInput): PrContent {
	const ctx: PrFragmentContext = buildContext(input);
	const overrides = input.templateOverrides ?? {};
	return {
		title: composeTitle(ctx, overrides, TITLE_MAX_LENGTH),
		body: composeBody(ctx, overrides),
	};
}

function buildContext(input: BuildPrContentInput): PrFragmentContext {
	const ctx: {
		prompt: string;
		runId: string;
		agentName: string;
		warrenBaseUrl?: string;
		commits?: readonly PrCommit[];
		diffStat?: string;
		seed?: PrSeed;
		startedAt?: string;
		endedAt?: string;
		costUsd?: number;
		tokensInput?: number;
		tokensOutput?: number;
		tokensCacheRead?: number;
		previewOptedIn?: boolean;
		agentNotes?: string;
	} = {
		prompt: input.prompt,
		runId: input.runId,
		agentName: input.agentName,
	};
	if (input.warrenBaseUrl !== undefined) ctx.warrenBaseUrl = input.warrenBaseUrl;
	if (input.commits !== undefined) ctx.commits = input.commits;
	if (input.diffStat !== undefined) ctx.diffStat = input.diffStat;
	if (input.seed !== undefined) ctx.seed = input.seed;
	if (input.startedAt !== undefined) ctx.startedAt = input.startedAt;
	if (input.endedAt !== undefined) ctx.endedAt = input.endedAt;
	if (input.costUsd !== undefined) ctx.costUsd = input.costUsd;
	if (input.tokensInput !== undefined) ctx.tokensInput = input.tokensInput;
	if (input.tokensOutput !== undefined) ctx.tokensOutput = input.tokensOutput;
	if (input.tokensCacheRead !== undefined) ctx.tokensCacheRead = input.tokensCacheRead;
	if (input.previewOptedIn !== undefined) ctx.previewOptedIn = input.previewOptedIn;
	if (input.agentNotes !== undefined) ctx.agentNotes = input.agentNotes;
	return ctx;
}

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export interface AutoOpenPrConfig {
	readonly enabled: boolean;
	readonly warrenBaseUrl: string | null;
}

export type AutoOpenEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the auto-open config (warren-f6af). `WARREN_AUTO_OPEN_PR` defaults
 * to enabled — the seed's whole point is "agent run → reviewable change with
 * no manual hop". Anything that isn't a recognized falsy value (`0`, `false`,
 * `no`, `off`, case-insensitive, with whitespace tolerated) leaves it on, so
 * an operator can disable globally with `WARREN_AUTO_OPEN_PR=false` without
 * tripping a stricter parser.
 */
export function loadAutoOpenPrConfigFromEnv(env: AutoOpenEnvLike = process.env): AutoOpenPrConfig {
	const raw = env.WARREN_AUTO_OPEN_PR;
	const enabled = raw === undefined ? true : !isFalsy(raw);
	return {
		enabled,
		warrenBaseUrl: env.WARREN_BASE_URL ?? null,
	};
}

function isFalsy(raw: string): boolean {
	const v = raw.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off" || v === "";
}
