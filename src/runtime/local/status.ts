/**
 * `LocalProvider.status` body (pl-829f step 9, phase CONTRACT). Wraps burrow's
 * `runs.get` into the seam's out-of-band `RunStatus` reconcile snapshot — what
 * the watchdog / recovery / pod-watcher read. NEVER throws on a missing run
 * (§6.7 correction 7): a burrow 404 returns `exists:false`, a value not a throw.
 *
 * ## burrow run.state → RunPhase / TerminalReason mapping
 *
 * Burrow's `RunState` union (`queued|running|succeeded|failed|cancelled`) is
 * BYTE-IDENTICAL to the seam's `RunPhase`, so `phase` maps 1:1. `terminalReason`
 * is the coarse terminal classification the seam adds (§3 keeps the fine-grained
 * `failure_reason` in the domain):
 *
 * | burrow run.state | discriminator                       | phase      | terminalReason |
 * |------------------|-------------------------------------|------------|----------------|
 * | queued           | —                                   | queued     | (none)         |
 * | running          | —                                   | running    | (none)         |
 * | succeeded        | —                                   | succeeded  | completed      |
 * | failed           | errorMessage carries the OOM marker | failed     | oom_killed     |
 * | failed           | otherwise                           | failed     | error          |
 * | cancelled        | —                                   | cancelled  | cancelled      |
 * | (404 / missing)  | run row gone (restart / GC)         | failed     | lost           |
 *
 * ### The OOM signal warren currently discards (§6.5 correction 7)
 * burrow 0.3.15 enforces a per-sandbox cgroup v2 `memory.max`; an OOM kill
 * surfaces two ways from burrow (`../burrow/SPEC.md` §"cgroup v2 resource
 * enforcement", `runner/dispatch.ts`): (1) an in-stream `oom_killed` system
 * event, and (2) on the run row a `failed` state whose `errorMessage` is exactly
 * `sandbox memory limit exceeded (oom-killed, exit <code>)`. `runs.get` only
 * carries the row, so `status()` recovers the signal off the `errorMessage`
 * marker rather than the event — promoting it to a first-class `oom_killed`
 * terminalReason instead of letting it read as an anonymous `error` (which is
 * all warren does with it today). K8s will give the same via
 * `terminated.reason == "OOMKilled"`.
 *
 * ### `lastEventSeq` / `lastEventTs`
 * `runs.get` carries no event cursor, so the two heartbeat anchors come from a
 * bounded replay of the burrow's events (`events.replay`, `follow=0`), taking
 * the last event scoped to this run. Empty ⇒ `seq:0`, `ts:null`. This is a
 * second burrow round-trip on a reconcile path — see the SEAM SIGNAL note on
 * `lastEventCursor`.
 */

import type { Run as BurrowRun } from "@os-eco/burrow-cli";
import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { RunHandle, RunPhase, RunStatus, TerminalReason } from "../contract.ts";

/** The exact substring burrow stamps onto an OOM-killed run's `errorMessage`. */
const BURROW_OOM_MARKER = "oom-killed";

/**
 * Reconcile snapshot for a run. `runs.tryGet` returns `null` on burrow's 404
 * (via `allow404`) — the purpose-built no-throw probe — which the seam surfaces
 * as `exists:false` + `terminalReason:"lost"` (§6.7). A live run maps its state
 * per the module table; the event cursor rides a bounded events replay.
 */
export async function localRunStatus(client: BurrowClient, handle: RunHandle): Promise<RunStatus> {
	const run = await withTransportMapping(client.config, () =>
		client.http.runs.tryGet(handle.providerRunId),
	);
	if (run === null) {
		// burrow 404 — the run row is gone (machine restart wiped burrow's store,
		// deliberate cleanup, GC). A reconcile value, not a throw. Reported as a
		// terminal `failed` so the domain stops waiting, tagged `lost` so it knows
		// the run vanished rather than failing on its own merits.
		return {
			phase: "failed",
			exitCode: null,
			terminalReason: "lost",
			lastEventSeq: 0,
			lastEventTs: null,
			exists: false,
		};
	}
	const cursor = await lastEventCursor(client, handle.sandboxId, handle.providerRunId);
	const terminalReason = terminalReasonFor(run);
	return {
		phase: run.state as RunPhase,
		exitCode: run.exitCode,
		...(terminalReason !== null ? { terminalReason } : {}),
		lastEventSeq: cursor.seq,
		lastEventTs: cursor.ts,
		exists: true,
	};
}

/**
 * Classify a live burrow run row into the seam's coarse terminal reason.
 * Non-terminal states (`queued`/`running`) return `null` (no reason yet). A
 * `failed` row is split on the OOM marker so the cgroup kill is first-class.
 */
function terminalReasonFor(run: BurrowRun): TerminalReason | null {
	switch (run.state) {
		case "succeeded":
			return "completed";
		case "cancelled":
			return "cancelled";
		case "failed":
			return isOomFailure(run.errorMessage) ? "oom_killed" : "error";
		default:
			// queued | running — not terminal.
			return null;
	}
}

function isOomFailure(errorMessage: string | null): boolean {
	return errorMessage?.includes(BURROW_OOM_MARKER) ?? false;
}

/**
 * Last event `{ seq, ts }` for a run, scoped by `runId`. burrow exposes no
 * cheap "latest event" query (its `events` tail only reads FORWARD from a
 * `since` cursor), so the honest source is a bounded replay of the burrow's
 * events with `follow=0` — the last row is the max seq (server-assigned
 * monotonic). Empty ⇒ `{ seq:0, ts:null }`.
 *
 * SEAM SIGNAL (step 13): this is a second burrow round-trip that drains the
 * event log on a reconcile path. K8s would instead carry a log-line cursor as
 * cheap state on the pod; the LocalProvider pays the drain because burrow's
 * HTTP surface offers nothing lighter. Keep it out of any hot loop.
 */
async function lastEventCursor(
	client: BurrowClient,
	burrowId: string,
	burrowRunId: string,
): Promise<{ seq: number; ts: string | null }> {
	let seq = 0;
	let ts: string | null = null;
	const source = client.http.events.replay(burrowId);
	try {
		for (;;) {
			const next = await withTransportMapping(client.config, () => source.next());
			if (next.done === true) break;
			const event = next.value;
			// Scope to this run: a burrow *could* host >1 run and burrow-level
			// lifecycle events carry `runId:null`. seq is monotonic, so the last
			// matching row carries the max — track it without buffering the log.
			if (event.runId !== burrowRunId) continue;
			if (event.seq >= seq) {
				seq = event.seq;
				ts = event.ts instanceof Date ? event.ts.toISOString() : String(event.ts);
			}
		}
	} finally {
		await source.return(undefined).catch(() => {});
	}
	return { seq, ts };
}
