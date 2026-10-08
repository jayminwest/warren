/**
 * The ui-visual sticky PR comment (warren-70d9): which failed golden cases
 * to show, and the comment text. Pure, so `bun test` covers it with no
 * network and no images.
 *
 * Input is `out/golden-diff/<case>/result.json` from the `ui-screenshots-<sha>`
 * artifact (`golden.pw.ts` writes it). The PR's own code wrote that file, so
 * every field is validated against a strict shape and nothing free-form (the
 * error text, the URL) reaches the comment verbatim.
 */

import { GOLDEN_UPDATE_HINT } from "./golden-cases.ts";
import { THEMES, VIEWPORT_NAMES } from "./pages.ts";

/** Hidden marker that keys the one ui-visual comment per PR. */
export const UI_VISUAL_MARKER = "<!-- ui-visual -->";

/** At most this many failures get an inline crop; the rest are a count line. */
export const MAX_SHOWN_FAILURES = 6;

export interface GoldenFailure {
	/** `<page>.<viewport>.<theme>`, also the `golden-diff/` directory name. */
	readonly name: string;
	readonly page: string;
	readonly viewport: string;
	readonly theme: string;
	/** Which of expected/actual/diff.png exist for the case. */
	readonly images: readonly ("expected" | "actual" | "diff")[];
	/** Pixel count from Playwright's message, when it reported one. */
	readonly reportedPixels: number | null;
	/** `[expected, actual]` sizes when Playwright reported a size change. */
	readonly sizeChange: readonly [string, string] | null;
}

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_KINDS = ["expected", "actual", "diff"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one `result.json`. Returns null for anything that does not match
 * what `golden.pw.ts` writes: a known viewport and theme, kebab-case page id,
 * and a case name equal to `<page>.<viewport>.<theme>`.
 */
export function parseGoldenResult(raw: unknown): GoldenFailure | null {
	if (!isRecord(raw)) return null;
	const { case: name, page, viewport, theme, images, error } = raw;
	if (typeof page !== "string" || !SEGMENT.test(page)) return null;
	if (!VIEWPORT_NAMES.some((v) => v === viewport) || !THEMES.some((t) => t === theme)) return null;
	if (name !== `${page}.${viewport}.${theme}`) return null;
	const kinds = Array.isArray(images) ? images : [];
	const message = typeof error === "string" ? error : "";
	return {
		name,
		page,
		viewport: String(viewport),
		theme: String(theme),
		images: IMAGE_KINDS.filter((k) => kinds.includes(`${k}.png`)),
		reportedPixels: reportedPixels(message),
		sizeChange: sizeChange(message),
	};
}

/** `N pixels (ratio 0.03 of all image pixels) are different.` -> N. */
export function reportedPixels(message: string): number | null {
	const match = /(\d{1,12}) pixels \(ratio [\d.]+ of all image pixels\)/.exec(message);
	return match?.[1] === undefined ? null : Number(match[1]);
}

/** `Expected an image 1440px by 900px, received 1440px by 950px.` -> sizes. */
export function sizeChange(message: string): [string, string] | null {
	const match = /Expected an image (\d+)px by (\d+)px, received (\d+)px by (\d+)px/.exec(message);
	if (match === null) return null;
	return [`${match[1]}x${match[2]}`, `${match[3]}x${match[4]}`];
}

export interface ShownFailure {
	readonly failure: GoldenFailure;
	/** Share of the golden's pixels that differ, 0..1, or null if unknown. */
	readonly ratio: number | null;
	/** Raw URL of the composite crop, or null when it could not be published. */
	readonly imageUrl: string | null;
	/** Human note on the crop (region, truncation, scale). */
	readonly note: string;
}

/** Biggest change first, then by name, so the cap keeps the loudest cases. */
export function pickFailures<T extends { failure: GoldenFailure; ratio: number | null }>(
	rows: readonly T[],
	max = MAX_SHOWN_FAILURES,
): { shown: T[]; hidden: number } {
	const sorted = [...rows].sort(
		(a, b) => (b.ratio ?? 2) - (a.ratio ?? 2) || a.failure.name.localeCompare(b.failure.name),
	);
	return { shown: sorted.slice(0, max), hidden: Math.max(0, sorted.length - max) };
}

/** `0.0123` -> `1.23%`; tiny but non-zero ratios never round to 0. */
export function formatRatio(ratio: number | null): string {
	if (ratio === null) return "n/a";
	if (ratio > 0 && ratio < 0.0001) return "<0.01%";
	return `${(ratio * 100).toFixed(2)}%`;
}

export interface RunRef {
	readonly headSha: string;
	readonly runUrl: string;
}

function header(run: RunRef): string {
	return `Head \`${run.headSha.slice(0, 7)}\` · [workflow run](${run.runUrl}) · [all screenshots (artifact)](${run.runUrl}#artifacts)`;
}

function changeCell(row: ShownFailure): string {
	const size = row.failure.sizeChange;
	const ratio = formatRatio(row.ratio);
	return size === null ? ratio : `${ratio}, size ${size[0]} → ${size[1]}`;
}

function failureSection(row: ShownFailure): string[] {
	const f = row.failure;
	const title = `<code>${f.page}</code> · ${f.viewport} · ${f.theme}`;
	const body =
		row.imageUrl === null
			? ["The crop could not be published; open the artifact for the images."]
			: [`![${f.name}](${row.imageUrl})`];
	return ["<details open>", `<summary>${title}</summary>`, "", row.note, "", ...body, "</details>"];
}

/** The comment for a run whose golden comparison failed. */
export function failureComment(run: RunRef, rows: readonly ShownFailure[], hidden: number): string {
	const total = rows.length + hidden;
	const noun = total === 1 ? "golden screenshot differs" : "golden screenshots differ";
	const lines = [
		UI_VISUAL_MARKER,
		`### ui-visual: ${total} ${noun}`,
		"",
		header(run),
		"",
		"| Page | Viewport | Theme | Pixels changed | Crop |",
		"| --- | --- | --- | --- | --- |",
		...rows.map(
			(r) =>
				`| \`${r.failure.page}\` | ${r.failure.viewport} | ${r.failure.theme} | ${changeCell(r)} | ${
					r.imageUrl === null ? "artifact" : `[image](${r.imageUrl})`
				} |`,
		),
	];
	if (hidden > 0) {
		lines.push(
			"",
			`…and ${hidden} more failing case${hidden === 1 ? "" : "s"}, only in the artifact.`,
		);
	}
	lines.push(
		"",
		"Each crop shows, left to right: the golden, this PR, and the diff (changed pixels in red).",
		"",
	);
	for (const row of rows) lines.push(...failureSection(row), "");
	lines.push(`If the change is intended, ${GOLDEN_UPDATE_HINT}.`);
	return `${lines.join("\n")}\n`;
}

/** The comment once a later run matches the goldens again. */
export function resolvedComment(run: RunRef): string {
	return [
		UI_VISUAL_MARKER,
		"### ui-visual: golden screenshots match",
		"",
		header(run),
		"",
		"The golden diffs posted here earlier no longer reproduce.",
		"",
	].join("\n");
}

/** The comment when ui-visual failed with no golden diff (smoke, a11y, build). */
export function noDiffFailureComment(run: RunRef): string {
	return [
		UI_VISUAL_MARKER,
		"### ui-visual: failed, no golden diffs",
		"",
		header(run),
		"",
		"This run reported no golden screenshot diff, but ui-visual failed elsewhere (the build, the baseline guard, smoke, or a11y). The workflow log names the failure.",
		"",
	].join("\n");
}

export type CommentAction = "post-failures" | "resolve" | "note-no-diff" | "none";

/**
 * What to do with the sticky comment. Failures always post. A clean run only
 * edits a comment that already exists, so a PR that never failed stays quiet.
 */
export function commentAction(input: {
	conclusion: string;
	failures: number;
	hasComment: boolean;
}): CommentAction {
	if (input.failures > 0) return "post-failures";
	if (!input.hasComment) return "none";
	return input.conclusion === "success" ? "resolve" : "note-no-diff";
}

/** Human note for a crop: where it sits on the page and how it was scaled. */
export function cropNote(c: {
	box: { x: number; y: number; width: number; height: number };
	truncated: boolean;
	scale: number;
}): string {
	const parts = [`Crop of ${c.box.width}x${c.box.height} px at (${c.box.x}, ${c.box.y})`];
	if (c.truncated) parts.push("the changed region continues below");
	if (c.scale > 1) parts.push(`shown at 1/${c.scale} scale`);
	return `${parts.join("; ")}.`;
}
