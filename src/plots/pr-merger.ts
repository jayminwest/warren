/**
 * `PlotPrMerger` \u2014 click-to-merge seam for
 * `POST /plots/:id/attachments/:ref/merge` (warren-8e39 / pl-0344
 * step 14).
 *
 * Mirrors `PlotAttacher` / `PlotQuestionAnswerer` in shape (one
 * interface + `defaultPlotPrMerger` production impl + `ServerDeps`
 * test seam) so handlers stay disk-free in unit tests.
 *
 * Resolves the `gh_pr` attachment by external ref, parses the ref
 * into `{owner, repo, number}` (URL or `owner/repo#N` shorthand),
 * calls `mergePullRequest`, and surfaces the result alongside the
 * fresh Plot envelope subset. The handler layer is responsible for
 * scheduling the follow-up `refreshProjectClone` on a successful
 * merge so the local clone picks up the new merge commit.
 *
 * Like the other Plot mutation seams, this surface is NOT
 * fire-and-log: the user is waiting on the click, so failure must
 * surface synchronously as the HTTP response.
 */

import type { Attachment, Intent, Plot, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { type MergePullRequestResult, mergePullRequest, parsePullRequestRef } from "../runs/pr.ts";
import {
	PlotAttachmentNotFoundError,
	PlotPrAttachmentInvalidError,
	PlotPrAttachmentMismatchedKindError,
} from "./errors.ts";

export interface MergePlotPrRequest {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	/** External ref of the gh_pr attachment (URL or `owner/repo#N`). */
	readonly ref: string;
	/** GitHub bearer token. Empty string = `missing_token` result. */
	readonly token: string;
	readonly mergeMethod?: "merge" | "squash" | "rebase";
	/** Optional fetch seam for tests. */
	readonly fetch?: typeof fetch;
}

export interface MergePlotPrResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
	/** The merge attempt result \u2014 surfaced verbatim to the handler. */
	readonly merge: MergePullRequestResult;
	/** Attachment id (`att-NNN`) the ref resolved to. */
	readonly attachment_id: string;
}

export interface PlotPrMerger {
	merge(input: MergePlotPrRequest): Promise<MergePlotPrResult>;
}

export const defaultPlotPrMerger: PlotPrMerger = {
	async merge(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const handle = client.get(input.plotId);
			const current = await handle.read();
			const target = current.attachments.find((a) => a.ref === input.ref);
			if (target === undefined) {
				throw new PlotAttachmentNotFoundError(
					`plot ${input.plotId} has no attachment with ref '${input.ref}'`,
					{
						recoveryHint:
							"check the ref against the Plot's current attachments[]; the attachment may have already been removed",
					},
				);
			}
			if (target.type !== "gh_pr") {
				throw new PlotPrAttachmentMismatchedKindError(
					`attachment '${input.ref}' on plot ${input.plotId} is kind '${target.type}', not 'gh_pr'`,
					{
						recoveryHint:
							"only gh_pr attachments can be merged; check the ref or re-attach as kind=gh_pr",
					},
				);
			}
			const parsed = parsePullRequestRef(input.ref);
			if (parsed === null) {
				throw new PlotPrAttachmentInvalidError(
					`gh_pr attachment '${input.ref}' is not a recognized PR shape (expected 'https://github.com/<owner>/<repo>/pull/<n>' or '<owner>/<repo>#<n>')`,
					{
						recoveryHint:
							"only github.com PRs are mergeable through warren; detach + re-attach with a canonical URL or owner/repo#N ref",
					},
				);
			}

			const merge = await mergePullRequest({
				owner: parsed.owner,
				repo: parsed.repo,
				number: parsed.number,
				token: input.token,
				...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
				...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
			});

			// Refresh the post-merge Plot snapshot. The merge call itself
			// does NOT mutate the Plot; we re-read so callers receive a
			// consistent envelope (the same posture as attach/detach).
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toResult(plot, events, merge, target.id);
		} finally {
			client.close();
		}
	},
};

function toResult(
	plot: Plot,
	events: readonly PlotEvent[],
	merge: MergePullRequestResult,
	attachmentId: string,
): MergePlotPrResult {
	return {
		id: plot.id,
		name: plot.name,
		status: plot.status,
		intent: plot.intent,
		attachments: plot.attachments,
		event_log: [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
		merge,
		attachment_id: attachmentId,
	};
}
