/**
 * Scenario 08 — POST /runs/:id/cancel terminates the run on both sides.
 *
 * Acceptance criterion #8:
 *   "POST /runs/:id/cancel forwards a graceful cancel to burrow, the
 *   warren run row reaches `cancelled`, and both the burrow API and
 *   warren API surfaces report the run as cancelled."
 *
 * `cancelRun` (mx-fadaa2) does NOT mutate state inline by default — it
 * forwards to burrow and lets the bridge/reap pipeline finalize the row.
 * The `warren-a69a` shortcut: when burrow's cancel response carries a
 * terminal `state`, `cancelRun` calls `reapRun` inline so the warren row
 * finalizes without waiting for an external reap scheduler. That's the
 * happy path here — burrow accepts the cancel, returns burrowRun.state in
 * {cancelled, succeeded, failed}, and warren transitions through reap to
 * the same terminal state.
 *
 * Verification surface:
 *   1. Spawn a long-running stub run (`[sleep_ms=...]` in the prompt) and
 *      poll until it leaves `queued` so the cancel call doesn't race the
 *      bridge.
 *   2. POST /runs/:id/cancel → 200, alreadyTerminal=false, burrowRun
 *      non-null with a terminal state. The `state` field on the response
 *      is what `cancelRun` returned after reap; if it's already terminal
 *      we trust that. Otherwise we poll GET /runs/:id until state lands.
 *   3. GET /runs/:id eventually shows state='cancelled'.
 *   4. The events log carries a `cancel.requested` audit event with
 *      payload.mode='forwarded' (mx-95f53b).
 *   5. Idempotency — a second POST /cancel returns 200 with
 *      alreadyTerminal=true and burrowRun=null (no second wire call).
 *
 * Negative paths exercised: unknown run id → 404. (Empty / missing body
 * is allowed for cancel — the route accepts an empty body, see
 * `cancelRunHandler` + `readJsonBodyOrEmpty`.)
 */

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
}

interface RunRow {
	readonly id: string;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
	readonly state: string;
	readonly endedAt: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface BurrowRun {
	readonly id: string;
	readonly state: string;
}

interface CancelResponse {
	readonly state: string;
	readonly alreadyTerminal: boolean;
	readonly burrowRun: BurrowRun | null;
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

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export const scenario: Scenario = {
	id: "08",
	title:
		"POST /runs/:id/cancel terminates run; both warren + burrow surfaces report cancelled (idempotent)",
	modes: ["in-proc", "container"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// Pre-reqs. Scenarios share a warren+burrow pair, so the sample
		// project may already exist from a sibling scenario — reuse it
		// instead of failing on the "already exists" 400.
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// Spawn a long-running run so cancel has something to actually
		// cancel (rather than racing a stub agent that exits in 5ms).
		const spawn = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "[sleep_ms=10000] scenario-08 cancellable run",
			},
		});
		const run = spawn.run;
		assertTrue(
			typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
			"spawn response missing burrowRunId — cancel path needs the burrow run id",
		);

		// Wait for the bridge to mirror queued→running (mx-30a49a) so we
		// exercise the "running → cancelled" path rather than the queued
		// short-circuit. 4s is enough for burrow to dispatch the agent and
		// for the first stdout line to round-trip into events.
		await waitForRunning(http, run.id, 4_000);

		// 1. POST /cancel — happy path. Returns the burrow run row plus
		//    the warren state after reap (warren-a69a).
		const cancel = await http.expectJson<CancelResponse>(
			"POST",
			`/runs/${encodeURIComponent(run.id)}/cancel`,
			200,
			{ body: { reason: "scenario-08 verification" } },
		);
		assertEqual(cancel.alreadyTerminal, false, "first cancel should NOT report alreadyTerminal");
		if (cancel.burrowRun === null) {
			throw new AcceptanceError("cancel response burrowRun is null on the forwarded path");
		}
		assertTrue(
			TERMINAL_STATES.has(cancel.burrowRun.state),
			`burrowRun.state on cancel response must be terminal; got '${cancel.burrowRun.state}'`,
		);

		// 2. Warren run row eventually reflects a terminal state. The
		//    cancel response's `state` may already be terminal (warren-a69a
		//    inline reap) or non-terminal (slower reap path). Poll either way.
		const finalState = await waitForTerminal(http, run.id, 6_000);
		assertEqual(
			finalState,
			"cancelled",
			"warren run row reaches state='cancelled' after graceful cancel",
		);

		// 3. cancel.requested event with mode=forwarded on the events log.
		const events = await fetchAllEvents(http, run.id);
		const cancelEvent = events.find((e) => e.kind === "cancel.requested");
		if (cancelEvent === undefined) {
			throw new AcceptanceError(
				`no cancel.requested event on /runs/${run.id}/events; got kinds: ${events.map((e) => e.kind).join(", ")}`,
			);
		}
		assertEqual(
			cancelEvent.stream,
			"system",
			"cancel.requested event uses stream='system' (mx-e7e5b5)",
		);
		const payload = cancelEvent.payload ?? {};
		assertEqual(payload.mode, "forwarded", "cancel.requested mode='forwarded' on the burrow path");
		assertEqual(
			payload.reason,
			"scenario-08 verification",
			"cancel.requested payload.reason mirrors request",
		);
		assertEqual(
			payload.burrowRunId,
			run.burrowRunId,
			"cancel.requested payload.burrowRunId matches the spawn-time burrow run id",
		);

		// 4. Idempotency — second cancel reports alreadyTerminal and no
		//    second burrow wire call (burrowRun=null).
		const idem = await http.expectJson<CancelResponse>(
			"POST",
			`/runs/${encodeURIComponent(run.id)}/cancel`,
			200,
			{ body: {} },
		);
		assertEqual(
			idem.alreadyTerminal,
			true,
			"second cancel on a terminal run reports alreadyTerminal=true",
		);
		assertEqual(idem.state, "cancelled", "idempotent cancel reports state='cancelled'");
		assertEqual(
			idem.burrowRun,
			null,
			"idempotent cancel does not re-call burrow; burrowRun is null",
		);

		// 5. Unknown run id → 404. (Cancel without body is fine; cancel
		//    accepts empty body via readJsonBodyOrEmpty.)
		const unknownRes = await http.request("POST", "/runs/run_doesnotexist/cancel", { body: {} });
		assertEqual(unknownRes.status, 404, "cancel on unknown run id returns 404");
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

async function waitForRunning(http: WarrenHttp, runId: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let lastState = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		lastState = row.state;
		if (row.state === "running") return;
		// If the agent already finished (very fast container schedulers can
		// blow past `running` before we observe it), bail with a clearer
		// message — we can't cancel a terminal run.
		if (TERMINAL_STATES.has(row.state)) {
			throw new AcceptanceError(
				`run reached terminal state '${row.state}' before cancel scenario could observe 'running' — increase the prompt's [sleep_ms=...] knob`,
			);
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach 'running' within ${timeoutMs}ms (last state=${lastState})`,
	);
}

async function waitForTerminal(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	let lastState = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		lastState = row.state;
		if (TERMINAL_STATES.has(row.state)) return row.state;
		await sleep(100);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach a terminal state within ${timeoutMs}ms (last state=${lastState})`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
