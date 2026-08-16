/**
 * PR-body template fragments + project override parser (warren-bd49).
 *
 * `buildPrContent` (src/runs/pr.ts) composes its body from the named
 * fragments below. Projects override individual fragments via a
 * `.warren/pr-template.md` file: each `## <fragment_name>` H2 in that
 * file replaces the default body for that fragment. Fragments the
 * project doesn't list keep their defaults — partial-override is the
 * point, so a project can ship a custom `trailer` without re-stating
 * every other section.
 *
 * The fragment registry is the load-bearing piece: the body comes
 * from `composeBody(fragments, ctx)`, never from inline string
 * concatenation. The `preview_url_or_placeholder` fragment is one
 * entry in the registry, not a special case — the R-19 reap-time
 * preview launcher still works the same way because the fragment
 * default emits the same `<!-- warren:preview-start -->…-end -->`
 * markers `annotatePrPreview` (src/runs/pr-annotate.ts) patches.
 *
 * V1 keeps the format simple: project overrides are literal markdown
 * — NO variable interpolation. A project that wants per-run dynamic
 * data (commits, cost, seed link) keeps the default fragment; an
 * override replaces with static text. Doctor warns on unknown
 * fragment names so typos surface loudly (acceptance #4).
 */

import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START, type PrCommit, type PrSeed } from "./pr.ts";

/**
 * The fixed set of recognized fragment names. Order is the body order
 * — `composeBody` walks this list in sequence. Adding a fragment is a
 * breaking docs change; rename is a backwards-incompatible config
 * change (project overrides keyed by the old name would silently
 * become unknown-fragment warnings).
 */
export const PR_FRAGMENT_NAMES = [
	"title",
	"summary",
	"agent_notes",
	"run",
	"seeds",
	"preview_url_or_placeholder",
	"commits",
	"files_changed",
	"prompt",
	"trailer",
] as const;

export type PrFragmentName = (typeof PR_FRAGMENT_NAMES)[number];

/**
 * Fragments rendered into the body, in body order. `title` is rendered
 * separately into the PR title, not the body — kept out of this list.
 */
export const PR_BODY_FRAGMENT_NAMES: readonly PrFragmentName[] = PR_FRAGMENT_NAMES.filter(
	(n): n is PrFragmentName => n !== "title",
);

/** GitHub rejects pull-request bodies at or above this API limit. */
export const MAX_PR_BODY_LENGTH = 65_536;

/**
 * The one PR-body clamp. `composeBody` applies it as the final fallback,
 * and `annotatePrPreview` (src/runs/pr-annotate.ts) re-clamps through it
 * before its PATCH so a near-limit body plus a failure tail never 422s.
 * The clamp lives here in the domain by decision (forge-contract.md §3,
 * PR #805, mx-026320) — never in a provider or in transport.
 */
export function clampPrBodyLength(body: string): string {
	return body.length <= MAX_PR_BODY_LENGTH ? body : `${body.slice(0, MAX_PR_BODY_LENGTH - 1)}…`;
}

const PR_FRAGMENT_NAME_SET: ReadonlySet<string> = new Set<string>(PR_FRAGMENT_NAMES);

/** A project's per-fragment override map. Missing keys keep the default. */
export type PrTemplateOverrides = Partial<Record<PrFragmentName, string>>;

export interface PrTemplateWarning {
	readonly code: "unknown_fragment" | "no_fragments" | "unclosed_preview_markers";
	readonly message: string;
}

export interface ParsedPrTemplate {
	readonly overrides: PrTemplateOverrides;
	readonly warnings: readonly PrTemplateWarning[];
}

/**
 * The dynamic context a fragment's default renderer needs. Mirrors
 * `BuildPrContentInput` shape — kept here to avoid a cycle with
 * `pr.ts` (which imports `composeBody` from this module).
 */
export interface PrFragmentContext {
	readonly prompt: string;
	readonly runId: string;
	readonly agentName: string;
	readonly warrenBaseUrl?: string;
	readonly commits?: readonly PrCommit[];
	readonly diffStat?: string;
	readonly seed?: PrSeed;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly costUsd?: number;
	readonly tokensInput?: number;
	readonly tokensOutput?: number;
	readonly tokensCacheRead?: number;
	readonly previewOptedIn?: boolean;
	/**
	 * Body (not the subject) of the run's final commit, lifted at reap time
	 * into an `## Agent notes` section under Summary (warren-5e86). Empty /
	 * whitespace-only / undefined → the fragment is omitted entirely.
	 */
	readonly agentNotes?: string;
}

/**
 * Parse a `.warren/pr-template.md` file into per-fragment overrides.
 *
 * Format: `^##\s+(name)\s*$` delimits fragments. Body lines after a
 * header (until the next header or EOF) are the override; whitespace-
 * only bodies remove the fragment from output. Names are normalized
 * to snake_case (lowercase, dashes/spaces → underscores) so authors
 * can write `## Files Changed` or `## files-changed` interchangeably.
 *
 * Unknown names are dropped + warned — operators see the typo via
 * the doctor surface (acceptance #4). Bodies before the first H2 are
 * ignored so an author can add a top-level `# Project PR template`
 * comment without it bleeding into any fragment.
 *
 * `preview_url_or_placeholder` overrides are additionally checked
 * for paired markers: a body containing one of
 * `<!-- warren:preview-start -->` / `<!-- warren:preview-end -->`
 * but not the other emits an `unclosed_preview_markers` warning,
 * since `annotatePrPreview` won't be able to patch the live URL
 * later.
 */
export function parsePrTemplate(content: string): ParsedPrTemplate {
	const lines = content.split("\n");
	const headerRe = /^##\s+(.+?)\s*$/;
	interface Section {
		readonly name: string;
		readonly rawName: string;
		readonly bodyLines: string[];
		readonly lineNumber: number;
	}
	const sections: Section[] = [];
	let current: Section | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const m = headerRe.exec(line);
		if (m !== null) {
			const rawName = m[1] as string;
			current = {
				name: normalizeFragmentName(rawName),
				rawName,
				bodyLines: [],
				lineNumber: i + 1,
			};
			sections.push(current);
		} else if (current !== null) {
			current.bodyLines.push(line);
		}
	}

	const warnings: PrTemplateWarning[] = [];
	const overrides: PrTemplateOverrides = {};

	for (const sec of sections) {
		if (!PR_FRAGMENT_NAME_SET.has(sec.name)) {
			warnings.push({
				code: "unknown_fragment",
				message: `unknown fragment "${sec.rawName}" at line ${sec.lineNumber} (known: ${PR_FRAGMENT_NAMES.join(", ")})`,
			});
			continue;
		}
		const name = sec.name as PrFragmentName;
		const body = stripTrailingBlankLines(sec.bodyLines).join("\n");
		overrides[name] = body;
		if (name === "preview_url_or_placeholder") {
			const hasStart = body.includes(PREVIEW_FRAGMENT_START);
			const hasEnd = body.includes(PREVIEW_FRAGMENT_END);
			if (hasStart !== hasEnd) {
				warnings.push({
					code: "unclosed_preview_markers",
					message: `preview_url_or_placeholder override at line ${sec.lineNumber} has one of <!-- warren:preview-start --> / <!-- warren:preview-end --> but not both; the reap-time annotator won't patch the live URL`,
				});
			}
		}
	}

	if (sections.length === 0 && content.trim() !== "") {
		warnings.push({
			code: "no_fragments",
			message: `no '## <fragment_name>' H2 headings found; the file is ignored. Add e.g. '## trailer' to override the trailer fragment.`,
		});
	}

	return { overrides, warnings };
}

/**
 * Compose the PR body from the registered fragments, applying any
 * project overrides. Empty body for a fragment (whitespace-only
 * override) is treated as "remove from output" — matches canopy's
 * section-merging semantics (mx-1c92f3 in canopy).
 */
export function composeBody(ctx: PrFragmentContext, overrides: PrTemplateOverrides = {}): string {
	const out: Array<{ name: PrFragmentName; rendered: string }> = [];
	for (const name of PR_BODY_FRAGMENT_NAMES) {
		const rendered = renderFragment(name, ctx, overrides);
		if (rendered === null) continue;
		out.push({ name, rendered });
	}
	let body = out.map((fragment) => fragment.rendered).join("\n\n");
	if (body.length <= MAX_PR_BODY_LENGTH) return body;

	const commitsIndex = out.findIndex((fragment) => fragment.name === "commits");
	if (commitsIndex >= 0 && overrides.commits === undefined && ctx.commits !== undefined) {
		const prefix = out
			.slice(0, commitsIndex)
			.map((fragment) => fragment.rendered)
			.join("\n\n");
		const suffix = out
			.slice(commitsIndex + 1)
			.map((fragment) => fragment.rendered)
			.join("\n\n");
		const separators = (prefix === "" ? 0 : 2) + (suffix === "" ? 0 : 2);
		const budget = MAX_PR_BODY_LENGTH - prefix.length - suffix.length - separators;
		out[commitsIndex] = {
			name: "commits",
			rendered: boundedCommits(ctx.commits, budget),
		};
		body = out.map((fragment) => fragment.rendered).join("\n\n");
	}

	// Custom templates can still be larger than GitHub's limit. Keep the
	// request safe even when there is no default commit fragment to shorten.
	return clampPrBodyLength(body);
}

/**
 * Resolve the title via the same override system. Project's `title`
 * override wins when non-empty; otherwise the default precedence
 * applies (seed title > first commit subject > first prompt line >
 * `warren run <id> (<agent>)` fallback). Title is always truncated
 * to `maxLength` chars.
 */
export function composeTitle(
	ctx: PrFragmentContext,
	overrides: PrTemplateOverrides,
	maxLength: number,
): string {
	const override = overrides.title;
	let raw: string;
	if (override !== undefined && override.trim() !== "") {
		raw = override.trim();
	} else {
		raw = defaultTitleSource(ctx);
	}
	return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 1)}…`;
}

function renderFragment(
	name: PrFragmentName,
	ctx: PrFragmentContext,
	overrides: PrTemplateOverrides,
): string | null {
	const override = overrides[name];
	if (override !== undefined) {
		const trimmed = override.trim();
		if (trimmed === "") return null;
		return trimmed;
	}
	return defaultRender(name, ctx);
}

function defaultRender(name: PrFragmentName, ctx: PrFragmentContext): string | null {
	switch (name) {
		case "title":
			return null; // handled by composeTitle
		case "summary":
			return defaultSummary(ctx);
		case "agent_notes":
			return ctx.agentNotes !== undefined ? defaultAgentNotes(ctx.agentNotes) : null;
		case "run":
			return defaultRun(ctx);
		case "seeds":
			return ctx.seed === undefined ? null : defaultSeeds(ctx.seed);
		case "preview_url_or_placeholder":
			return ctx.previewOptedIn === true ? defaultPreview() : null;
		case "commits":
			return ctx.commits !== undefined && ctx.commits.length > 0
				? defaultCommits(ctx.commits)
				: null;
		case "files_changed":
			return ctx.diffStat !== undefined && ctx.diffStat.trim() !== ""
				? defaultFilesChanged(ctx.diffStat)
				: null;
		case "prompt":
			return defaultPrompt(ctx.prompt);
		case "trailer":
			return defaultTrailer(ctx.runId);
	}
}

function defaultSummary(ctx: PrFragmentContext): string {
	const commits = ctx.commits;
	if (commits !== undefined && commits.length > 0) {
		return `## Summary\n\n${commits[0]?.subject ?? ""}`;
	}
	const duration = formatDuration(ctx.startedAt, ctx.endedAt);
	const tail = duration === null ? "no commits." : `for ${duration}; no commits.`;
	return `## Summary\n\nAgent \`${ctx.agentName}\` ran ${tail}`;
}

/**
 * `## Agent notes` from the final commit's body (warren-5e86). Sanitized:
 * trailing whitespace stripped per line and the whole body trimmed; an empty
 * result omits the section (returns null). A body containing markdown
 * headers is fenced wholesale so it cannot break the PR body's own `##`
 * section structure.
 */
function defaultAgentNotes(rawBody: string): string | null {
	const body = rawBody
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
	if (body === "") return null;
	const hasHeaders = body.split("\n").some((line) => line.startsWith("#"));
	const rendered = hasHeaders ? `\`\`\`markdown\n${body}\n\`\`\`` : body;
	return `## Agent notes\n\n${rendered}`;
}

function defaultRun(ctx: PrFragmentContext): string {
	const lines = ["## Run", ""];
	const link =
		ctx.warrenBaseUrl !== undefined && ctx.warrenBaseUrl !== ""
			? `${ctx.warrenBaseUrl.replace(/\/+$/, "")}/#/runs/${ctx.runId}`
			: `\`${ctx.runId}\``;
	lines.push(`- **Warren run:** ${link}`);
	lines.push(`- **Agent:** ${ctx.agentName}`);
	const duration = formatDuration(ctx.startedAt, ctx.endedAt);
	if (duration !== null) lines.push(`- **Duration:** ${duration}`);
	const cost = formatCostLine(ctx);
	if (cost !== null) lines.push(`- **Cost:** ${cost}`);
	return lines.join("\n");
}

function defaultSeeds(seed: PrSeed): string {
	return `## Seeds\n\n- ${seed.id} — ${seed.title}`;
}

function defaultPreview(): string {
	return `## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}`;
}

function defaultCommits(commits: readonly PrCommit[]): string {
	const lines = [`## Commits (${commits.length})`, ""];
	for (const c of commits) {
		lines.push(`- ${shortSha(c.sha)} ${c.subject}`);
	}
	return lines.join("\n");
}

function boundedCommits(commits: readonly PrCommit[], budget: number): string {
	const header = `## Commits (${commits.length})\n\n`;
	if (budget <= header.length) return header.slice(0, Math.max(0, budget));
	const lines = [header];
	let remaining = budget - header.length;
	for (let index = 0; index < commits.length; index += 1) {
		const commit = commits[index];
		if (commit === undefined) continue;
		const line = `- ${shortSha(commit.sha)} ${commit.subject}\n`;
		const left = commits.length - index - 1;
		const summary = left > 0 ? `- ...and ${left} more` : "";
		if (line.length + (summary === "" ? 0 : summary.length) <= remaining) {
			lines.push(line);
			remaining -= line.length;
			continue;
		}
		if (left > 0 && summary.length <= remaining) lines.push(summary);
		break;
	}
	return lines.join("").trimEnd();
}

function defaultFilesChanged(diffStat: string): string {
	return `## Files changed\n\n\`\`\`\n${diffStat.trim()}\n\`\`\``;
}

function defaultPrompt(prompt: string): string {
	const body = prompt === "" ? "(empty prompt)" : prompt;
	return `## Prompt\n\n<details><summary>Show prompt</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`;
}

function defaultTrailer(runId: string): string {
	return `---\n\n🤖 Opened by warren run \`${runId}\``;
}

function defaultTitleSource(ctx: PrFragmentContext): string {
	if (ctx.seed !== undefined && ctx.seed.title !== "") return ctx.seed.title;
	const firstCommit = ctx.commits?.[0];
	if (firstCommit !== undefined && firstCommit.subject !== "") return firstCommit.subject;
	const firstLine = ctx.prompt
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	return firstLine ?? `warren run ${ctx.runId} (${ctx.agentName})`;
}

function normalizeFragmentName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

function stripTrailingBlankLines(lines: readonly string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
	while (out.length > 0 && (out[0] ?? "").trim() === "") out.shift();
	return out;
}

function shortSha(sha: string): string {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function formatDuration(startedAt: string | undefined, endedAt: string | undefined): string | null {
	if (startedAt === undefined || endedAt === undefined) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	const secs = Math.round((end - start) / 1000);
	if (secs < 60) return `${secs}s`;
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	if (m < 60) return `${m}m ${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ${s}s`;
}

function formatCostLine(ctx: PrFragmentContext): string | null {
	const parts: string[] = [];
	if (ctx.costUsd !== undefined) parts.push(formatCostUsd(ctx.costUsd));
	const tokens: string[] = [];
	if (ctx.tokensInput !== undefined) tokens.push(`${formatTokens(ctx.tokensInput)} in`);
	if (ctx.tokensOutput !== undefined) tokens.push(`${formatTokens(ctx.tokensOutput)} out`);
	if (ctx.tokensCacheRead !== undefined && ctx.tokensCacheRead > 0) {
		tokens.push(`${formatTokens(ctx.tokensCacheRead)} cache-r`);
	}
	if (tokens.length > 0) {
		const joined = tokens.join(" / ");
		parts.push(parts.length === 0 ? joined : `(${joined})`);
	}
	return parts.length === 0 ? null : parts.join(" ");
}

function formatCostUsd(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost === 0) return "$0.00";
	return `$${cost.toFixed(3)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
