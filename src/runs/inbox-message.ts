/**
 * `RunInboxRow` → seam `Message` mapper — the neutral home for the run_inbox
 * row projection.
 *
 * Extracted from `src/runtime/k8s/send-message.ts` (warren-5af5, same pattern as
 * warren-9574's `authenticatedCloneUrl`): the mapping is not k8s-specific. Both
 * the K8s provider's `sendMessage` (which enqueues into `run_inbox`) and the
 * provider-neutral poll endpoint `pollRunInbox` (`src/runs/inbox.ts`) project a
 * `run_inbox` row onto the contract's `Message`. Hosting it under
 * `src/runtime/k8s/` forced the local/shared poll path to import from the k8s
 * tree, so a k8s refactor could break local dispatch. `run_inbox` is a
 * warren-domain steering table, so the mapper now lives beside the domain poll.
 * Behavior is unchanged.
 */

import type { RunInboxRow } from "../db/schema.ts";
import type { Message } from "../runtime/contract.ts";

/**
 * Map a `run_inbox` row onto the seam's provider-neutral `Message`. `runId`
 * mirrors delivery-attribution semantics: `null` while `unread` (a fresh send),
 * the claiming run once `delivered`. Timestamps are already ISO-8601 TEXT, so no
 * Date round-trip.
 */
export function toSeamMessage(row: RunInboxRow): Message {
	return {
		id: row.id,
		runId: row.state === "unread" ? null : row.runId,
		body: row.body,
		priority: row.priority,
		fromActor: row.fromActor,
		state: row.state,
		createdAt: row.createdAt,
		deliveredAt: row.deliveredAt,
	};
}
