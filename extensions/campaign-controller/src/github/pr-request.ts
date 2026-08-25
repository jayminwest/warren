/**
 * Pure cross-fork pull-request intent rendering (warren-33aa).
 *
 * This module contains zero transport code. It renders the *exact* request
 * object a later authorized shepherd would POST to
 * `POST /repos/{upstreamOwner}/{upstreamRepo}/pulls` — head ref qualified
 * with the bot-owned fork login — and freezes it as dry-run evidence.
 * The V0 client has no method that can send it, so rendering an intent can
 * never mutate GitHub (plan pl-91b6 §14.8).
 */

import { ValidationError } from "../errors.ts";

/** Inputs the controller derives from approved campaign + fork state. */
export interface CrossForkPullRequestIntentInput {
	upstreamOwner: string;
	upstreamRepo: string;
	/** Upstream branch the PR targets, e.g. `main`. */
	baseBranch: string;
	/** Login of the bot-owned fork that owns the head branch. */
	forkOwner: string;
	/** Branch name on the fork, e.g. `warren/issue-42`. */
	headBranch: string;
	title: string;
	body: string;
	/** Render as a draft PR (default true — dry-run posture). */
	draft?: boolean;
	/** Let upstream maintainers push to the fork branch (default true). */
	maintainerCanModify?: boolean;
}

/** The rendered, immutable, never-sent request. */
export interface CrossForkPullRequestIntent {
	/** Always "POST": recorded so evidence shows what would run, not what ran. */
	method: "POST";
	/** The would-be endpoint, absolute API path. */
	url: string;
	/** The exact JSON body a live shepherd would send. Frozen. */
	body: Readonly<{
		title: string;
		head: string;
		base: string;
		body: string;
		maintainer_can_modify: boolean;
		draft: boolean;
	}>;
}

/**
 * Render a cross-fork PR intent. Pure: no I/O, no transport, no clock.
 * Returns a deep-frozen object so downstream journal code cannot be blamed
 * for mutating evidence.
 */
export function renderCrossForkPullRequestIntent(
	input: CrossForkPullRequestIntentInput,
): CrossForkPullRequestIntent {
	for (const [field, value] of [
		["upstreamOwner", input.upstreamOwner],
		["upstreamRepo", input.upstreamRepo],
		["baseBranch", input.baseBranch],
		["forkOwner", input.forkOwner],
		["headBranch", input.headBranch],
		["title", input.title],
	] as const) {
		if (typeof value !== "string" || value.length === 0) {
			throw new ValidationError(`cross-fork PR intent field "${field}" is required`);
		}
	}
	if (typeof input.body !== "string" || input.body.length === 0) {
		throw new ValidationError('cross-fork PR intent field "body" is required');
	}
	const intent: CrossForkPullRequestIntent = {
		method: "POST",
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/pulls`,
		body: {
			title: input.title,
			head: `${input.forkOwner}:${input.headBranch}`,
			base: input.baseBranch,
			body: input.body,
			maintainer_can_modify: input.maintainerCanModify ?? true,
			draft: input.draft ?? true,
		},
	};
	return deepFreeze(intent);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value as Record<string, unknown>)) {
			deepFreeze(entry);
		}
		Object.freeze(value);
	}
	return value;
}
