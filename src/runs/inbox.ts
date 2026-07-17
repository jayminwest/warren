/**
 * `pollRunInbox` — the read/poll half of the pod-per-run steering channel
 * (`GET /runs/:id/inbox`, pl-829f step 18 / warren-3d0b).
 *
 * The K8s in-pod agent harness has no live socket back to warren; it polls this
 * endpoint over the Service-DNS callback URL (authenticated with the same
 * `WARREN_API_TOKEN` bearer as every other API call) to drain steering messages
 * warren's `K8sProvider.sendMessage` enqueued into `run_inbox`.
 *
 * Poll-CONSUME semantics (design doc §1.4): a poll atomically CLAIMS every
 * currently-`unread` row for the run — priority-desc then FIFO-by-`seq` — and
 * flips it to `delivered`. The claim is a single `UPDATE ... RETURNING`
 * (`RunInboxRepo.claimForDelivery`), so it is crash-safe and race-safe: two
 * concurrent polls never double-deliver a row (the second sees it already
 * `delivered` and claims nothing). Consequently the endpoint mutates on GET —
 * an at-most-once delivery contract the harness must tolerate (a message
 * claimed then lost to a pod crash is not redelivered; steering is a best-effort
 * nudge, not durable RPC).
 *
 * The run is validated to exist (`repos.runs.require` → 404 for an unknown id)
 * so a stale poll against a GC'd run surfaces cleanly instead of silently
 * returning an empty batch. Terminal runs are NOT rejected here — a run that
 * finished between enqueue and poll may still have undelivered rows the harness
 * legitimately wants to drain; the pod's own lifecycle bounds the poll loop.
 */

import type { Repos } from "../db/repos/index.ts";
import type { Message } from "../runtime/contract.ts";
import { toSeamMessage } from "./inbox-message.ts";

export interface PollRunInboxInput {
	readonly runId: string;
	readonly repos: Repos;
	readonly now?: () => Date;
}

export interface PollRunInboxResult {
	readonly messages: Message[];
}

/**
 * Claim and return the run's undelivered steering messages, oldest-priority-
 * first. Throws `NotFoundError` (→ 404) when the run does not exist.
 */
export async function pollRunInbox(input: PollRunInboxInput): Promise<PollRunInboxResult> {
	await input.repos.runs.require(input.runId);
	const now = input.now ?? (() => new Date());
	const claimed = await input.repos.runInbox.claimForDelivery(input.runId, { now: now() });
	return { messages: claimed.map(toSeamMessage) };
}
