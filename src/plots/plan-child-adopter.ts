/**
 * `PlanChildAdopter` — reconcile a Plot's `sd_plan` attachments with
 * the children of the plans they reference (warren-18a9).
 *
 * A Plot can carry a `seeds_issue` attachment whose `ref` is a seeds
 * plan id (`pl-*`) — the "sd_plan attachment" convention surfaced in
 * the UI's `isSdPlanAttachment` predicate (src/ui/src/pages/plot-detail/
 * helpers.ts) and the `POST /plot-plan-runs` synthesis filter. Plan
 * children and Plot attachments are otherwise independent data
 * structures: adding a seed as a child to such a plan (via `sd plan`)
 * does NOT add a matching `seeds_issue` attachment to the Plot, so the
 * Plot's substrate panel drifts out of parity with the plan.
 *
 * This seam closes that gap. Given a Plot, it finds every `sd_plan`
 * attachment, reads each plan's children via `showPlan`, and attaches
 * any child seed that is not already present as a `seeds_issue`
 * attachment. The result is the list of newly adopted refs so the
 * caller can log / invalidate caches.
 *
 * Posture: best-effort and idempotent. A plan that fails to read (stale
 * ref, deleted plan, sd not on PATH) is skipped without aborting
 * adoption of the other plans. Children that already track the Plot are
 * left untouched, so re-running against a reconciled Plot adopts
 * nothing. The caller (`GET /plots/:id`) wraps the whole call in
 * fire-and-log so a reconciliation failure never breaks the read.
 */

import type { Attachment } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { type SeedsCliDeps, showPlan } from "../seeds-cli/index.ts";

/**
 * An `sd_plan` attachment is a `seeds_issue` whose `ref` looks like a
 * seeds plan id (`pl-*`). Mirrors the UI-side `isSdPlanAttachment`
 * predicate so warren's server + client agree on what counts as a plan
 * attachment.
 */
export function isSdPlanAttachmentRef(attachment: Attachment): boolean {
	return attachment.type === "seeds_issue" && /^pl-/i.test(attachment.ref);
}

export interface AdoptPlanChildrenRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Project clone root — `sd plan show` resolves `.seeds/` relative to cwd. */
	readonly projectPath: string;
	/** Target Plot id (`plot-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** Seeds CLI deps for the `sd plan show` shell-out. */
	readonly seedsCli: SeedsCliDeps;
}

export interface AdoptPlanChildrenResult {
	/** Child seed refs newly attached to the Plot, in adoption order. */
	readonly adopted: readonly string[];
}

export interface PlanChildAdopter {
	adopt(input: AdoptPlanChildrenRequest): Promise<AdoptPlanChildrenResult>;
}

/**
 * Production `PlanChildAdopter`. Opens one `UserPlotClient`, reads the
 * Plot, walks its `sd_plan` attachments, and attaches any plan child
 * not already present as a `seeds_issue` attachment.
 *
 * The `existing` set is seeded from the Plot's current `seeds_issue`
 * refs and grown as adoptions land, so two plans that share a child (or
 * a plan whose child is also directly attached) never produce a
 * duplicate attachment. `pl-*`-shaped children are skipped — adopting a
 * sub-plan as a `seeds_issue` would recurse the same drift; those are
 * dispatched via the per-row "Run plan" path, not adopted.
 */
export const defaultPlanChildAdopter: PlanChildAdopter = {
	async adopt(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const handle = client.get(input.plotId);
			const plot = await handle.read();
			const planAttachments = plot.attachments.filter(isSdPlanAttachmentRef);
			if (planAttachments.length === 0) return { adopted: [] };

			const existing = new Set(
				plot.attachments.filter((a) => a.type === "seeds_issue").map((a) => a.ref.toLowerCase()),
			);

			const adopted: string[] = [];
			for (const planAttachment of planAttachments) {
				let children: readonly string[];
				try {
					const plan = await showPlan(input.seedsCli, input.projectPath, planAttachment.ref);
					children = plan.children;
				} catch {
					// Best-effort: a stale/deleted plan ref must not abort
					// adoption of the remaining plans on this Plot.
					continue;
				}
				for (const childRef of children) {
					const key = childRef.toLowerCase();
					if (existing.has(key)) continue;
					if (/^pl-/i.test(childRef)) continue;
					await handle.attach({ type: "seeds_issue", ref: childRef, role: "tracks" });
					existing.add(key);
					adopted.push(childRef);
				}
			}
			return { adopted };
		} finally {
			client.close();
		}
	},
};
