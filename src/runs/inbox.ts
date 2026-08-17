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
 * Peek mode (`claim: false`, warren-3305) lists the unread rows WITHOUT
 * claiming them, so an operator or the UI can inspect the queue safely — a
 * bare poll is destructive on read, and a non-pod reader that claims steals
 * the message from the pod's steering poll. Peeked rows project through the
 * same `toSeamMessage`, so they read `state: "unread"` / `runId: null`.
 *
 * The run is validated to exist (`repos.runs.require` → 404 for an unknown id)
 * so a stale poll against a GC'd run surfaces cleanly instead of silently
 * returning an empty batch. Terminal runs are NOT rejected here — a run that
 * finished between enqueue and poll may still have undelivered rows the harness
 * legitimately wants to drain; the pod's own lifecycle bounds the poll loop.
 */

import type { Repos } from "../db/repos/index.ts";
import type { Message } from "../runtime/contract.ts";
import type { RunEventBroker } from "./events.ts";
import { toSeamMessage } from "./inbox-message.ts";

export interface PollRunInboxInput {
	readonly runId: string;
	readonly repos: Repos;
	/**
	 * `false` = PEEK (warren-3305): list the unread messages WITHOUT claiming
	 * them. Operators and the UI must use peek — a bare poll is poll-CONSUME,
	 * so an operator "just checking" the inbox claims and steals the message
	 * before the pod's steering poll ever sees it (the live warren-3305
	 * hazard). The pod's poll never peeks; exactly-once claiming is its
	 * delivery contract. Default `true` preserves the pre-flag behavior.
	 */
	readonly claim?: boolean;
	/** If supplied, `steer.delivered` audit events are published here too. */
	readonly broker?: RunEventBroker;
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
	if (input.claim === false) {
		const unread = await input.repos.runInbox.listUnreadByRun(input.runId);
		return { messages: unread.map(toSeamMessage) };
	}
	const claimed = await input.repos.runInbox.claimForDelivery(input.runId, { now: now() });
	await emitSteerDeliveredEvents(
		input,
		claimed.map((row) => row.id),
	);
	return { messages: claimed.map(toSeamMessage) };
}

/**
 * warren-3305: the delivery-side counterpart to `steer.sent`. A claim IS the
 * delivery signal — the in-pod harness has taken the messages off the queue —
 * so each claimed message gets a `steer.delivered` event on the run's log and
 * `steer.sent` alone stops reading as success. Note delivered means
 * handed-to-the-harness, not acted-on-by-the-agent; a harness that drains and
 * drops still emits this (that class needs agent-side acknowledgement, which
 * no builtin runtime exposes today). One event per message keeps the
 * analytics `kind`-based queries simple. Seq allocation mirrors
 * `emitSteerEvent` in `./steer.ts`.
 */
async function emitSteerDeliveredEvents(
	input: PollRunInboxInput,
	messageIds: readonly string[],
): Promise<void> {
	if (messageIds.length === 0) return;
	const now = input.now ?? (() => new Date());
	let seq = (await input.repos.events.maxSeqForRun(input.runId)) ?? 0;
	for (const messageId of messageIds) {
		seq += 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: now().toISOString(),
			kind: "steer.delivered",
			stream: "system",
			payload: { messageId },
		});
		input.broker?.publish(input.runId, row);
	}
}
