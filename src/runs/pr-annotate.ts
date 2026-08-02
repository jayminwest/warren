/**
 * `annotatePrPreview` — replace the `preview_url_or_placeholder` fragment
 * in a PR body with the live preview URL or the launch failure tail
 * (warren-f156 / docs/design/preview-environments.md).
 *
 * Sixth best-effort sub-step of `reapRun`, gated on:
 *   - `pr_open` produced a `prUrl` (no PR ⇒ nothing to annotate), and
 *   - `preview_launch` reached a terminal state (`live` or `failed`).
 *
 * The annotation patch is its own idempotent HTTP step:
 *
 *   1. GET  /repos/:owner/:repo/pulls/:n   → read current body
 *   2. Replace the markers + their content with the new fragment
 *      (`<!-- warren:preview-start -->\n…\n<!-- warren:preview-end -->`).
 *      Re-running on an already-patched body just replaces again — no
 *      drift, no duplication.
 *   3. PATCH /repos/:owner/:repo/pulls/:n  → write the new body
 *
 * If the placeholder markers aren't found (e.g. someone edited the PR
 * body and stripped them out, or the PR was opened before the preview
 * fragment landed), the annotator appends the section at the end of the
 * body rather than failing — operators reading the PR still see the
 * preview state, and the next annotation pass is still idempotent.
 *
 * Like `openPullRequest`, all errors are returned as discriminated-union
 * results; reap maps them into `reap_failed step=pr_annotate_preview`
 * events so a GitHub outage never fails the run.
 */

import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START } from "./pr.ts";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-annotate";

export interface AnnotatePrPreviewInput {
	/** Full GitHub PR URL — e.g. `https://github.com/owner/repo/pull/77`. */
	readonly prUrl: string;
	readonly token: string;
	/** Outcome of the preview launch — drives what gets patched in. */
	readonly preview:
		| { readonly state: "live"; readonly url: string }
		| { readonly state: "failed"; readonly failureTail: string };
}

export type AnnotatePrPreviewResult =
	| { readonly ok: true; readonly mode: "patched" | "unchanged" }
	| {
			readonly ok: false;
			readonly reason: "missing_token" | "bad_url" | "network" | "http_error";
			readonly message: string;
	  };

export interface AnnotatePrPreviewFetcher {
	readonly fetch: typeof fetch;
}

export async function annotatePrPreview(
	input: AnnotatePrPreviewInput,
	deps: AnnotatePrPreviewFetcher = { fetch: globalThis.fetch },
): Promise<AnnotatePrPreviewResult> {
	if (input.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot annotate pull request",
		};
	}
	const parsed = parsePrUrl(input.prUrl);
	if (parsed === null) {
		return {
			ok: false,
			reason: "bad_url",
			message: `unrecognized GitHub PR URL: ${input.prUrl}`,
		};
	}

	const headers = buildHeaders(input.token);
	const apiUrl = `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;

	let getRes: Response;
	try {
		getRes = await deps.fetch(apiUrl, { method: "GET", headers });
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (!getRes.ok) {
		const text = await readText(getRes);
		return {
			ok: false,
			reason: "http_error",
			message: `GET /pulls/${parsed.number} returned ${getRes.status}: ${truncate(text, 500)}`,
		};
	}
	const fetched = (await readJson(getRes)) as { body?: unknown } | null;
	const currentBody = typeof fetched?.body === "string" ? fetched.body : "";

	const newFragment = buildFragment(input.preview);
	const nextBody = replaceFragment(currentBody, newFragment);
	if (nextBody === currentBody) {
		return { ok: true, mode: "unchanged" };
	}

	let patchRes: Response;
	try {
		patchRes = await deps.fetch(apiUrl, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ body: nextBody }),
		});
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	if (!patchRes.ok) {
		const text = await readText(patchRes);
		return {
			ok: false,
			reason: "http_error",
			message: `PATCH /pulls/${parsed.number} returned ${patchRes.status}: ${truncate(text, 500)}`,
		};
	}
	return { ok: true, mode: "patched" };
}

interface ParsedPrUrl {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

/**
 * Accepts both the GitHub web URL (`https://github.com/o/r/pull/N`) and the
 * REST API resource URL (`https://api.github.com/repos/o/r/pulls/N`) so the
 * annotator works whether reap stashed `html_url` (web) or `url` (api).
 * `openPullRequest` returns `html_url`, so the common case is the first
 * shape — the second shape is a defensive fallback for callers that pass
 * `pulls[].url` instead of `pulls[].html_url`.
 */
export function parsePrUrl(input: string): ParsedPrUrl | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	const web = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(trimmed);
	if (web !== null) {
		const n = Number.parseInt(web[3] as string, 10);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { owner: web[1] as string, repo: web[2] as string, number: n };
	}
	const api = /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/.exec(
		trimmed,
	);
	if (api !== null) {
		const n = Number.parseInt(api[3] as string, 10);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { owner: api[1] as string, repo: api[2] as string, number: n };
	}
	return null;
}

function buildFragment(preview: AnnotatePrPreviewInput["preview"]): string {
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

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}
