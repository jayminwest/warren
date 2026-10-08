/**
 * One bot comment per PR per topic, edited in place (warren-70d9).
 *
 * A sticky comment is keyed by a hidden HTML marker on its first line. The
 * ui-visual diff comment uses `<!-- ui-visual -->`; the design-review
 * findings (warren-a694) post through the same helper with their own marker,
 * so the two never edit each other's comment. Only comments a bot account
 * wrote are candidates: a human quoting the marker is never edited.
 */

import type { GhApi } from "./gh-api.ts";

/** `design-review` -> `<!-- design-review -->`. Names are kebab-case. */
export function stickyMarker(name: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`bad sticky-comment name: ${name}`);
	return `<!-- ${name} -->`;
}

export interface StickyTarget {
	/** `owner/repo`. */
	readonly repo: string;
	readonly pr: number;
	/** The hidden marker, from `stickyMarker`. The body must start with it. */
	readonly marker: string;
}

export interface StickyComment {
	readonly id: number;
	readonly body: string;
}

interface RawComment {
	id?: unknown;
	body?: unknown;
	user?: { type?: unknown } | null;
}

/** The first bot comment whose body starts with the marker, if any. */
export function pickStickyComment(
	comments: readonly unknown[],
	marker: string,
): StickyComment | null {
	for (const raw of comments as RawComment[]) {
		if (typeof raw.id !== "number" || typeof raw.body !== "string") continue;
		if (raw.user?.type !== "Bot") continue;
		if (raw.body.startsWith(marker)) return { id: raw.id, body: raw.body };
	}
	return null;
}

export async function findStickyComment(
	api: GhApi,
	target: StickyTarget,
): Promise<StickyComment | null> {
	const comments = await api.paginate(
		`repos/${target.repo}/issues/${target.pr}/comments?per_page=100`,
	);
	return pickStickyComment(comments, target.marker);
}

function checkBody(target: StickyTarget, body: string): void {
	if (!body.startsWith(target.marker)) {
		throw new Error(`sticky comment body must start with ${target.marker}`);
	}
}

export type StickyResult =
	| { readonly action: "created" | "updated" | "unchanged"; readonly id: number }
	| { readonly action: "absent" };

/** Create the comment, or edit the existing one in place. */
export async function upsertStickyComment(
	api: GhApi,
	target: StickyTarget,
	body: string,
	existing?: StickyComment | null,
): Promise<StickyResult> {
	checkBody(target, body);
	const current = existing === undefined ? await findStickyComment(api, target) : existing;
	if (current !== null) return editComment(api, target, current, body);
	const created = (await api.request("POST", `repos/${target.repo}/issues/${target.pr}/comments`, {
		body,
	})) as { id?: unknown } | null;
	return { action: "created", id: typeof created?.id === "number" ? created.id : -1 };
}

/** Edit the comment only if one exists; never creates one. */
export async function updateStickyCommentIfPresent(
	api: GhApi,
	target: StickyTarget,
	body: string,
	existing?: StickyComment | null,
): Promise<StickyResult> {
	checkBody(target, body);
	const current = existing === undefined ? await findStickyComment(api, target) : existing;
	if (current === null) return { action: "absent" };
	return editComment(api, target, current, body);
}

async function editComment(
	api: GhApi,
	target: StickyTarget,
	current: StickyComment,
	body: string,
): Promise<StickyResult> {
	if (current.body === body) return { action: "unchanged", id: current.id };
	await api.request("PATCH", `repos/${target.repo}/issues/comments/${current.id}`, { body });
	return { action: "updated", id: current.id };
}
