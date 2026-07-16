/**
 * `LocalProvider.sendMessage` body (pl-829f step 10, phase CONTRACT). Wraps
 * burrow's `POST /burrows/:id/inbox` (`http.inbox.send`) — the SAME call the
 * domain's `steerRun` (`src/runs/steer.ts`) makes today — as the seam's
 * `sendMessage(handle, msg)`, and re-shapes burrow's persisted `Message` row
 * onto the provider-neutral `Message` the contract returns.
 *
 * Faithful to `steer.ts`'s burrow-touching half:
 *   - Target: burrow's inbox is scoped per-burrow (not per-run), so the send
 *     addresses `handle.sandboxId` (the burrowId), exactly as steer resolves
 *     `run.burrowId`. Delivery lands on the next agent turn on that burrow.
 *   - Params: `body` is always sent; `priority` and `fromActor` ride ONLY when
 *     the caller supplied them (`... ? {x} : {}`), byte-for-byte with steer.
 *     The provider invents NO defaults — burrow owns the `priority` default
 *     ("normal") and the `fromActor` default server-side, which preserves the
 *     priority-desc-then-FIFO claim ordering and the unread→delivered→failed
 *     lifecycle burrow enforces on its own side. Distorting the defaults here
 *     would silently re-rank the queue.
 *   - Transport: wrapped in `withTransportMapping` so a dead socket surfaces as
 *     `BurrowUnreachableError` (steer does the same). A burrow 404 (ghost
 *     burrow) is NEUTRALIZED at the seam (warren-1f56): it re-throws as the
 *     provider-neutral `RuntimeRunNotFoundError` so `steerRun` maps it onto its
 *     `ValidationError` HTTP envelope without importing `@os-eco/burrow-cli`'s
 *     error class. Other `BurrowError` subclasses propagate unchanged.
 *
 * ## burrow `Message` (MessageRow) → seam `Message`
 *
 * | seam field    | burrow field         | note                                    |
 * |---------------|----------------------|-----------------------------------------|
 * | `id`          | `id`                 | 1:1                                     |
 * | `runId`       | `deliveredAtRunId`   | the run that CLAIMED it; `null` while   |
 * |               |                      | unread (a fresh send is always unread)  |
 * | `body`        | `body`               | 1:1                                     |
 * | `priority`    | `priority`           | identical union, forwarded verbatim     |
 * | `fromActor`   | `fromActor`          | 1:1 (burrow-defaulted when omitted)     |
 * | `state`       | `state`              | identical union (unread/delivered/failed)|
 * | `createdAt`   | `createdAt` (Date)   | serialized to ISO-8601                  |
 * | `deliveredAt` | `deliveredAt` (Date?)| ISO-8601 or `null`                      |
 *
 * burrow's `deliveredAtRunId` has no per-`msg` analogue in `OutboundMessage`;
 * the seam surfaces it as `runId` (the delivery attribution) — `null` on the
 * unread row a send returns, populated once a later turn claims the message.
 */

import type { Message as BurrowMessage } from "@os-eco/burrow-cli";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { Message, OutboundMessage, RunHandle } from "../contract.ts";
import { mapBurrowError } from "./error-map.ts";

/**
 * Enqueue a steering message onto the run's burrow inbox and return the
 * persisted row mapped onto the seam's `Message`. `handle.sandboxId` is the
 * burrowId the inbox is scoped to; `handle.providerRunId` is deliberately NOT
 * used — burrow attributes delivery itself when a turn claims the message.
 */
export async function sendLocalMessage(
	client: BurrowClient,
	handle: RunHandle,
	msg: OutboundMessage,
): Promise<Message> {
	let row: BurrowMessage;
	try {
		row = await withTransportMapping(client.config, () =>
			client.http.inbox.send({
				burrowId: handle.sandboxId,
				body: msg.body,
				...(msg.priority !== undefined ? { priority: msg.priority } : {}),
				...(msg.fromActor !== undefined ? { fromActor: msg.fromActor } : {}),
			}),
		);
	} catch (err) {
		// Neutralize burrow errors at the seam (warren-1f56, warren-36cb): a ghost
		// burrow (burrow 404) surfaces to the domain as the provider-neutral
		// `RuntimeRunNotFoundError` so `steerRun` never imports `@os-eco/burrow-cli`'s
		// error class. Any burrow class with no neutral analogue propagates unchanged.
		throw mapBurrowError(err, {
			runNotFoundHint: "the run is likely lost; the bridge will reconcile it to failed",
		});
	}
	return toSeamMessage(row);
}

/**
 * Map burrow's persisted `Message` row onto the seam's provider-neutral
 * `Message`. Dates serialize to ISO-8601 strings; `deliveredAtRunId` becomes
 * the seam's `runId` delivery attribution. No field is dropped or defaulted —
 * the row is burrow's source of truth for the lifecycle.
 */
function toSeamMessage(row: BurrowMessage): Message {
	return {
		id: row.id,
		runId: row.deliveredAtRunId,
		body: row.body,
		priority: row.priority,
		fromActor: row.fromActor,
		state: row.state,
		createdAt: row.createdAt.toISOString(),
		deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
	};
}
