/**
 * `K8sProvider.sendMessage` body (pl-829f step 18, phase K8S / warren-3d0b).
 *
 * The K8s analogue of `local/send-message.ts`. LocalProvider wraps burrow's
 * per-burrow inbox (`http.inbox.send`); K8s has no live socket into the
 * pod-per-run sandbox, so warren persists the steering message in the
 * `run_inbox` table and the in-pod agent harness polls `GET /runs/:id/inbox`
 * to drain it (design doc §1.4 / runtime-provider-contract §5 midRunSteering).
 *
 * Parity with LocalProvider's semantics:
 *   - **Enqueue, don't deliver.** A fresh send always lands `unread`; delivery
 *     is deferred to the next poll (LocalProvider: the next agent turn on the
 *     burrow). Priority-desc-then-FIFO claim ordering + the
 *     unread→delivered→failed lifecycle are enforced by the poll endpoint /
 *     repo, not distorted here.
 *   - **Defaults belong to the store, not the seam.** `priority` / `fromActor`
 *     ride only when the caller supplied them (`... ? {x} : {}`, byte-for-byte
 *     with LocalProvider). The `run_inbox` column defaults (`normal` /
 *     `operator`) own the absent case, exactly as burrow owns them server-side —
 *     inventing a default here would silently re-rank the queue.
 *   - **Gone run ⇒ `RuntimeRunNotFoundError`.** `RunInboxRepo.enqueue` returns
 *     `null` when the target run row is absent; this maps that to the seam's
 *     neutral not-found error so `steerRun` renders a clean `ValidationError`
 *     (identical to LocalProvider mapping burrow's 404). Terminal-run gating
 *     stays UPSTREAM in `steerRun` (LocalProvider is terminal-agnostic too).
 *   - **Misconfiguration ⇒ `RuntimeProviderError`.** No wired store is a
 *     warren-side "provider can't satisfy the intent" failure (mirrors
 *     LocalProvider throwing when `hostClonePathHint` is missing), raised before
 *     anything is persisted.
 *
 * ## `run_inbox` row → seam `Message`
 *
 * The row→`Message` projection itself lives in the neutral `src/runs/inbox-
 * message.ts` (`toSeamMessage`, warren-5af5) — it is shared with the local/
 * shared poll path (`src/runs/inbox.ts`) and is not k8s-specific.
 *
 * | seam field    | row field           | note                                     |
 * |---------------|---------------------|------------------------------------------|
 * | `id`          | `id`                | 1:1 (`msg_…`)                            |
 * | `runId`       | `runId`             | delivery attribution: `null` while       |
 * |               |                     | `unread` (a fresh send is unread),       |
 * |               |                     | the claiming run once `delivered`. In    |
 * |               |                     | pod-per-run the target IS the claimer.   |
 * | `body`        | `body`              | 1:1                                      |
 * | `priority`    | `priority`          | identical union, forwarded verbatim      |
 * | `fromActor`   | `fromActor`         | 1:1 (store-defaulted when omitted)       |
 * | `state`       | `state`             | identical union (unread/delivered/failed)|
 * | `createdAt`   | `createdAt`         | already ISO-8601 TEXT — no conversion    |
 * | `deliveredAt` | `deliveredAt`       | ISO-8601 TEXT or `null`                  |
 */

import type { EnqueueRunInboxInput } from "../../db/repos/run-inbox.ts";
import type { RunInboxRow } from "../../db/schema.ts";
import { toSeamMessage } from "../../runs/inbox-message.ts";
import type { Message, OutboundMessage, RunHandle } from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";

/**
 * The narrow write surface `K8sProvider.sendMessage` needs from the run_inbox
 * store — a structural subset of `RunInboxRepo` so the provider stays decoupled
 * from the full repo. `enqueue` returns `null` for an absent target run.
 */
export interface K8sInboxStore {
	enqueue(input: EnqueueRunInboxInput): Promise<RunInboxRow | null>;
}

/**
 * Persist a steering message into `run_inbox` for `handle.runId` and return the
 * seam `Message`. `handle.sandboxId` (the pod name) is deliberately unused — the
 * inbox is keyed by the warren run id the in-pod poll addresses, not the pod.
 */
export async function sendK8sMessage(
	store: K8sInboxStore | undefined,
	handle: RunHandle,
	msg: OutboundMessage,
): Promise<Message> {
	if (store === undefined) {
		throw new RuntimeProviderError(
			"K8s runtime has no run_inbox store wired; steering is unavailable",
			{
				recoveryHint:
					"the run_inbox store is threaded from ServerDeps at boot (src/server/main/deps.ts); a K8sProvider built without it cannot persist steering messages.",
			},
		);
	}

	const row = await store.enqueue({
		runId: handle.runId,
		body: msg.body,
		...(msg.priority !== undefined ? { priority: msg.priority } : {}),
		...(msg.fromActor !== undefined ? { fromActor: msg.fromActor } : {}),
	});
	if (row === null) {
		throw new RuntimeRunNotFoundError(
			`run ${handle.runId} not found; cannot enqueue steering message`,
			{ recoveryHint: "the run is likely lost; the bridge will reconcile it to failed" },
		);
	}
	return toSeamMessage(row);
}
