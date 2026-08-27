/**
 * Scenario 38 — K8s steering delivered within ~5s (warren-245d, pl-829f step 25
 * SHIP; design k8s-migration.md §1.4 + step-4 "verify").
 *
 * Acceptance criterion:
 *   "POST /runs/:id/steer against a K8s-backed run enqueues the message onto the
 *    `run_inbox` and it becomes drainable over `GET /runs/:id/inbox` within ~5s
 *    (the in-pod agent's poll interval)."
 *
 * Pod-per-run has no live socket to the agent (contract §5 `midRunSteering:
 * false`), so steering rides a warren-side inbox the in-pod harness polls:
 * `K8sProvider.sendMessage` writes to `run_inbox` (Postgres), and the agent
 * drains it via `GET /runs/:id/inbox` — a poll-CONSUME that atomically claims
 * `unread` rows and flips them `delivered` (`src/runs/inbox.ts`). This scenario
 * exercises that channel end-to-end by playing BOTH roles: it steers, then polls
 * the inbox exactly as the in-pod agent would, asserting the message is claimed
 * within the ~5s design budget. This is verifiable against any K8s-backed warren
 * with a live run — it does not depend on the agent image's own poll loop, only
 * on the enqueue → poll delivery path warren owns.
 *
 * Two deterministic warren-side witnesses are checked:
 *   1. the `steer.sent` audit event on the run's event log (the send side,
 *      mirroring scenario 07);
 *   2. the message drained off `GET /runs/:id/inbox` with matching id + body
 *      within the delivery window (the K8s poll-delivery side).
 *
 * ## Determinism / self-cleaning
 *
 * Idempotent: dispatches its own run, steers once, drains once, and cancels in
 * `finally` (idempotent). Because the inbox poll is CONSUME-once, the scenario
 * is the sole poller of its own run — it never races a real agent for the row.
 */

import { createHmacRunTokenMinter } from "../../../src/runs/spawn/run-token.ts";
import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";
import { resolveK8sTarget } from "../lib/k8s-target.ts";
import { pollAcceptance } from "../lib/poll.ts";

interface RunRow {
	readonly id: string;
	readonly state: string;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface SteerMessage {
	readonly id: string;
	readonly body: string;
	readonly priority: string;
}

interface SteerResponse {
	readonly message: SteerMessage;
}

interface InboxMessage {
	readonly id: string;
	readonly body: string;
	readonly state: string;
	readonly fromActor: string;
}

interface InboxResponse {
	readonly messages: readonly InboxMessage[];
}

interface EventRow {
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
const MESSAGE_ID_PATTERN = /^msg_[0-9a-hjkmnpqrstvwxyz]+$/;
/** The design's ~5s in-pod poll interval, plus slack for scheduling jitter. */
const DELIVERY_DEADLINE_MS = 8_000;
const POLL_INTERVAL_MS = 250;

export const scenario: Scenario = {
	id: "38",
	title: "K8s steering: POST /runs/:id/steer is drainable over GET /runs/:id/inbox within ~5s",
	// Attaches to an external K8s-backed warren via env; skips otherwise.
	modes: ["in-proc"],
	async run(ctx) {
		const target = resolveK8sTarget(ctx);
		const { http } = target;

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: target.agentName,
				project: target.projectId,
				prompt: "[scenario-38] long-lived run to receive a steering nudge",
			},
		});
		const runId = created.run.id;
		assertTrue(
			RUN_ID_PATTERN.test(runId),
			`spawn run.id ${runId} does not match ${RUN_ID_PATTERN}`,
		);

		try {
			// 0. (warren-5a5c) The K8s App-mode credential remint rides the
			//    run-scoped callback token: mint one for this run (same HMAC the
			//    server verifies, keyed off the operator token) and POST
			//    /runs/:id/git-credential with it — the exact request
			//    finalize-entrypoint.ts makes from inside the pod. Before
			//    warren-5a5c this was 403'd by the run-scope gate, so App-mode
			//    remint could never work. The target's forge may be PAT-mode and
			//    mint `null`; the pin here is the auth path (200 + well-formed
			//    body), which is forge-independent.
			const runScoped = createHmacRunTokenMinter(target.token).mint(runId);
			const mintRes = await fetch(
				target.http.url(`/runs/${encodeURIComponent(runId)}/git-credential`),
				{
					method: "POST",
					headers: { authorization: `Bearer ${runScoped}` },
				},
			);
			if (mintRes.status !== 200) {
				throw new AcceptanceError(
					`run-scoped POST git-credential returned HTTP ${mintRes.status} (expected 200 — warren-5a5c callback allowlist): ${await mintRes.text()}`,
				);
			}
			const mintBody = (await mintRes.json()) as { gitToken: string | null };
			assertTrue(
				typeof mintBody?.gitToken === "string" || mintBody?.gitToken === null,
				`git-credential body malformed: ${JSON.stringify(mintBody)}`,
			);
			ctx.logger.info("scenario-38: run-scoped git-credential remint accepted (warren-5a5c)");

			// 1. Steer promptly (the run is queued/running — non-terminal — so steer
			//    is accepted). The 200 body is the enqueued run_inbox row.
			const steerBody = "scenario-38: fold in the network-policy note on your next turn";
			const steer = await http.expectJson<SteerResponse>(
				"POST",
				`/runs/${encodeURIComponent(runId)}/steer`,
				200,
				{ body: { body: steerBody, priority: "normal", fromActor: "acceptance-harness" } },
			);
			assertTrue(
				typeof steer.message?.id === "string" && MESSAGE_ID_PATTERN.test(steer.message.id),
				`steer response message.id missing/malformed: ${JSON.stringify(steer.message?.id)}`,
			);
			assertEqual(steer.message.body, steerBody, "steer response mirrors the request body");
			ctx.logger.info(`scenario-38: steered ${runId} (msg=${steer.message.id})`);

			// 2. Warren-side send witness: the steer.sent audit event.
			const events = await fetchEvents(http, runId);
			const sent = events.find((e) => e.kind === "steer.sent");
			if (sent === undefined) {
				throw new AcceptanceError(
					`no steer.sent event on /runs/${runId}/events; got kinds: ${events.map((e) => e.kind).join(", ")}`,
				);
			}
			assertEqual(
				sent.payload?.messageId,
				steer.message.id,
				"steer.sent payload.messageId matches the enqueued message id",
			);

			// 3. K8s poll-delivery witness: drain GET /runs/:id/inbox as the in-pod
			//    agent would, asserting the message is claimed within the ~5s budget.
			const startedAt = Date.now();
			const delivered = await pollInboxFor(http, runId, steer.message.id, DELIVERY_DEADLINE_MS);
			const latencyMs = Date.now() - startedAt;
			ctx.logger.info(`scenario-38: inbox delivered msg=${steer.message.id} in ${latencyMs}ms`);
			assertEqual(delivered.body, steerBody, "delivered inbox message body matches the steer");
			assertEqual(
				delivered.fromActor,
				"acceptance-harness",
				"delivered inbox message preserves fromActor",
			);
			// The claim flips the row unread -> delivered; a claimed row reads either
			// (endpoint returns the pre-flip snapshot or the flipped one across builds).
			assertTrue(
				delivered.state === "delivered" || delivered.state === "unread",
				`delivered inbox message state should be delivered/unread, got ${delivered.state}`,
			);
		} finally {
			await safeCancel(http, runId, ctx);
		}
	},
};

async function pollInboxFor(
	http: WarrenHttp,
	runId: string,
	messageId: string,
	timeoutMs: number,
): Promise<InboxMessage> {
	return pollAcceptance({
		label: "steer inbox message",
		id: messageId,
		timeoutMs,
		intervalMs: POLL_INTERVAL_MS,
		fetchRow: async (): Promise<InboxMessage | null> => {
			const res = await http.expectJson<InboxResponse>(
				"GET",
				`/runs/${encodeURIComponent(runId)}/inbox`,
				200,
			);
			return res.messages.find((m) => m.id === messageId) ?? null;
		},
		isDone: (msg): msg is InboxMessage => msg !== null,
		describe: (msg) => (msg === null ? "not drainable yet" : msg.id),
	});
}

async function fetchEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

async function safeCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtxLike): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-38: best-effort cancel of ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

interface ScenarioCtxLike {
	readonly logger: { debug(msg: string): void };
}
