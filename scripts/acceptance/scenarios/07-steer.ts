/**
 * Scenario 07 — POST /runs/:id/steer reaches the burrow inbox.
 *
 * Acceptance criterion #7:
 *   "POST /runs/:id/steer accepts a steering body, forwards it to the
 *   burrow inbox (`POST /burrows/:sandbox_id/inbox` under the hood), and
 *   emits a `steer.sent` audit event onto the warren run's event log."
 *
 * The verification surface uses two pieces of evidence the operator can
 * actually see from the wire:
 *
 *   1. The steer response itself. `steerRun` returns the `Message` row
 *      that burrow's inbox API minted (mx-37e6ff). A 200 with a populated
 *      `message.id` (and matching `body` / `priority`) is direct
 *      proof-of-delivery — the warren-side response is the burrow API's
 *      response shape, so the only way it gets back to us is via a
 *      successful round-trip into the inbox.
 *
 *   2. The `steer.sent` audit event on `GET /runs/:id/events`. The audit
 *      event lives in warren's events table (stream='system', mx-e7e5b5)
 *      and its payload carries the same messageId, so a UI consumer that
 *      replays the event log can reconstruct what was sent.
 *
 * Validation paths exercised: empty body → 400, terminal-run → 400,
 * unknown-run → 404. The src/core/wire.ts error envelope shape is asserted on the
 * empty-body case so the error contract is anchored.
 *
 * Stays self-contained: spawns its own long-running stub run (sleep set
 * via `[sleep_ms=...]` in the prompt — see lib/stub-agent/claude-code-path-shim.sh) so
 * the warren row stays non-terminal during the steer call. Cleanup
 * cancels the run so teardown doesn't trip over a live agent.
 */

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
}

interface RunRow {
	readonly id: string;
	readonly sandboxId: string | null;
	readonly sandboxRunId: string | null;
	readonly state: string;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly sandbox: { readonly id: string; readonly workspacePath: string };
}

interface SteerMessage {
	readonly id: string;
	readonly priority: string;
	readonly body: string;
	readonly fromActor?: string | null;
}

interface SteerResponse {
	readonly message: SteerMessage;
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

interface ErrorEnvelope {
	readonly error: { readonly code: string; readonly message?: string };
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
// Inbox message ids are `msg_<uuid>` (src/runtime/local/run-store.ts).
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const scenario: Scenario = {
	id: "07",
	title: "POST /runs/:id/steer reaches burrow inbox + emits steer.sent audit event",
	// Steer requires a spawned run, which needs the host-side fixtures.
	// In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// Pre-reqs. Scenarios share a warren+burrow pair (one boot per
		// harness invocation), so the sample project may already exist
		// from a sibling scenario — reuse it instead of failing on the
		// "already exists" 400.
		// The stub agent was seeded at boot via WARREN_SEED_AGENTS_FILE
		// (warren-e376); POST /agents/refresh is deleted (pl-3a79). GET it
		// to prove boot seeding landed before spawning against it.
		await http.expectStatus(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Spawn a long-running run. The stub agent reads `[sleep_ms=...]`
		// from its prompt arg (see lib/stub-agent/claude-code-path-shim.sh) and sleeps so
		// the warren row stays non-terminal across the steer call.
		const spawnPrompt = "[sleep_ms=8000] scenario-07 steerable run";
		const spawn = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: spawnPrompt,
			},
		});
		const run = spawn.run;
		assertTrue(
			RUN_ID_PATTERN.test(run.id),
			`spawn run.id ${run.id} does not match ${RUN_ID_PATTERN}`,
		);
		assertTrue(
			typeof run.sandboxId === "string" && run.sandboxId !== null && run.sandboxId.length > 0,
			"spawn response missing sandboxId — steer needs sandbox_id (mx-37e6ff)",
		);

		// 1. Steer with a known body. 200 + message envelope from burrow.
		const steerBody = "scenario-07: please look at the network policy section";
		const steerRes = await http.expectJson<SteerResponse>(
			"POST",
			`/runs/${encodeURIComponent(run.id)}/steer`,
			200,
			{
				body: { body: steerBody, priority: "normal", fromActor: "acceptance-harness" },
			},
		);
		assertTrue(
			typeof steerRes.message?.id === "string" && MESSAGE_ID_PATTERN.test(steerRes.message.id),
			`steer response message.id missing or malformed: ${JSON.stringify(steerRes.message?.id)}`,
		);
		assertEqual(
			steerRes.message.body,
			steerBody,
			"steer response message.body mirrors request body",
		);
		assertEqual(steerRes.message.priority, "normal", "steer response message.priority");

		// 2. The steer.sent audit event lands on the run's event log.
		const events = await fetchAllEvents(http, run.id);
		const steerEvent = events.find((e) => e.kind === "steer.sent");
		if (steerEvent === undefined) {
			throw new AcceptanceError(
				`no steer.sent event on /runs/${run.id}/events; got kinds: ${events.map((e) => e.kind).join(", ")}`,
			);
		}
		assertEqual(steerEvent.stream, "system", "steer.sent event uses stream='system' (mx-e7e5b5)");
		const payload = steerEvent.payload ?? {};
		assertEqual(
			payload.messageId,
			steerRes.message.id,
			"steer.sent event payload.messageId matches the burrow message id",
		);
		assertEqual(payload.body, steerBody, "steer.sent event payload.body mirrors the request body");
		assertEqual(
			payload.fromActor,
			"acceptance-harness",
			"steer.sent event payload.fromActor mirrors the request",
		);

		// 3. Validation surface — empty body → 400 validation_error envelope.
		const emptyRes = await http.request("POST", `/runs/${encodeURIComponent(run.id)}/steer`, {
			body: { body: "" },
		});
		assertEqual(emptyRes.status, 400, "empty steer body returns 400");
		const emptyBody = (await emptyRes.json()) as ErrorEnvelope;
		assertEqual(
			emptyBody.error?.code,
			"validation_error",
			"empty steer body uses validation_error envelope",
		);

		// 4. Unknown run id → 404.
		const unknownRes = await http.request("POST", "/runs/run_doesnotexist/steer", {
			body: { body: "x" },
		});
		assertEqual(unknownRes.status, 404, "unknown run id on steer returns 404");

		// 5. Cleanup — cancel the run and steer again to prove "terminal
		//    run rejects steer". Both verifications fold into the cleanup.
		const cancelRes = await http.expectJson<{ alreadyTerminal: boolean }>(
			"POST",
			`/runs/${encodeURIComponent(run.id)}/cancel`,
			200,
			{ body: { reason: "scenario-07 cleanup" } },
		);
		assertTrue(typeof cancelRes.alreadyTerminal === "boolean", "cancel response shape");

		const terminalState = (await waitForRunTerminal(http, run.id, 8_000)).state;
		const terminalSteerRes = await http.request(
			"POST",
			`/runs/${encodeURIComponent(run.id)}/steer`,
			{ body: { body: "this should not land" } },
		);
		assertEqual(
			terminalSteerRes.status,
			400,
			`steer on a ${terminalState} run returns 400 (validation_error)`,
		);
		const terminalBody = (await terminalSteerRes.json()) as ErrorEnvelope;
		assertEqual(
			terminalBody.error?.code,
			"validation_error",
			"terminal-run steer uses validation_error envelope",
		);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: (ProjectRow & { gitUrl: string })[] }>(
		"GET",
		"/projects",
		200,
	);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return { id: existing.id };
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function fetchAllEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}
