/**
 * Preview-annotation body composition (warren-f156 /
 * docs/design/preview-environments.md; migrated onto the Forge seam in
 * warren-45e6).
 *
 * Sixth best-effort sub-step of `reapRun`, gated on:
 *   - `pr_open` produced a PR (no PR ⇒ nothing to annotate), and
 *   - `preview_launch` reached a terminal state (`live` or `failed`).
 *
 * This module is PURE DOMAIN (forge-contract.md §3): it composes the next PR
 * body from the body `pr_open` composed moments earlier in the same reap,
 * replacing the `preview_url_or_placeholder` fragment
 * (`<!-- warren:preview-start -->\n…\n<!-- warren:preview-end -->`) with the
 * live URL or the launch failure tail. The transport half — deciding WHICH
 * PR and PATCHing the body — is `forge.setPullRequestBody`, driven by
 * `runPreviewAnnotate` (`src/runs/reap/preview.ts`). No `api.github.com`, no
 * token, and no PR-URL grammar cross this file.
 *
 * If the placeholder markers aren't found (e.g. someone edited the PR body
 * and stripped them out, or the PR was opened before the preview fragment
 * landed), the composer appends the section at the end of the body rather
 * than failing — operators reading the PR still see the preview state, and
 * the next annotation pass is still idempotent.
 *
 * The composed body is re-clamped through the domain's 64KB clamp before the
 * forge call: `composeBody` clamps at open time, but this path appends a
 * failure tail to a body that can already sit near the limit — unclamped,
 * the PATCH 422s (forge-contract.md §3; PR #805 / mx-026320 place the clamp
 * in the domain, never in transport).
 */

import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START } from "./pr.ts";
import { clampPrBodyLength } from "./pr-template.ts";

/** Outcome of the preview launch — drives what gets patched in. */
export type PreviewAnnotationState =
	| { readonly state: "live"; readonly url: string }
	| { readonly state: "failed"; readonly failureTail: string };

export interface PreviewBodyEdit {
	/** The next PR body (clamped). Equals `currentBody` when nothing changed. */
	readonly body: string;
	/** False when the body already carried exactly this fragment. */
	readonly changed: boolean;
}

/**
 * Compose the annotated PR body. Pure: the caller (reap's
 * `pr_annotate_preview` sub-step) hands the result to
 * `forge.setPullRequestBody` only when `changed` is true, and reports the
 * `unchanged` mode otherwise.
 */
export function composePreviewBody(
	currentBody: string,
	preview: PreviewAnnotationState,
): PreviewBodyEdit {
	const nextBody = clampPrBodyLength(replaceFragment(currentBody, buildFragment(preview)));
	return { body: nextBody, changed: nextBody !== currentBody };
}

function buildFragment(preview: PreviewAnnotationState): string {
	const inner =
		preview.state === "live"
			? `[${preview.url}](${preview.url})`
			: formatFailureTail(preview.failureTail);
	return `${PREVIEW_FRAGMENT_START}\n${inner}\n${PREVIEW_FRAGMENT_END}`;
}

function formatFailureTail(tail: string): string {
	const trimmed = tail.trim();
	if (trimmed === "") return "❌ Preview failed (no stderr captured).";
	return `❌ Preview failed:\n\n\`\`\`\n${trimmed}\n\`\`\``;
}

/**
 * Replace the fragment between `PREVIEW_FRAGMENT_START` and
 * `PREVIEW_FRAGMENT_END` with `newFragment`. When the markers are absent,
 * append the new fragment under a `## Preview` heading at the end of the
 * body so the URL/failure tail still surfaces. Idempotent on re-run because
 * the resulting body always has exactly one occurrence of the markers.
 */
export function replaceFragment(body: string, newFragment: string): string {
	const startIdx = body.indexOf(PREVIEW_FRAGMENT_START);
	const endIdx = body.indexOf(PREVIEW_FRAGMENT_END);
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const before = body.slice(0, startIdx);
		const after = body.slice(endIdx + PREVIEW_FRAGMENT_END.length);
		return `${before}${newFragment}${after}`;
	}
	const trimmed = body.replace(/\s+$/, "");
	const separator = trimmed === "" ? "" : "\n\n";
	return `${trimmed}${separator}## Preview\n\n${newFragment}\n`;
}
