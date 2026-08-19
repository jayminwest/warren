/**
 * Scenario 06 — restart-recovery under the internalized LocalProvider
 * (docs/design/runtime-and-supervisor.md, AGENTS.md Runtime topology).
 *
 * Post burrow-absorption (plan pl-3007 / warren-ea0a) the local engine's
 * run store is in-process (`src/runtime/local/run-store.ts`). A warren
 * restart wipes that store, so live rows reconcile as `lost` on the next
 * `bootBridges()` pass — the same operator-visible outcome a burrow-daemon
 * restart produced. That is the documented local-topology posture, not a
 * regression.
 *
 * Acceptance criterion (redesigned, warren-8a6e):
 *   Killing warren mid-run and restarting it: the still-running warren
 *   row is reconciled to `failed` with `failureReason='sandbox_run_lost'`,
 *   a `bridge_lost` system event is appended, and the durable pre-kill
 *   events table is preserved (no truncate). The scenario no longer
 *   asserts bridge resume / MAX(seq)+1 continuity — that contract only
 *   held while a durable burrow daemon outlived warren.
 *
 * Lifecycle: requires `ctx.lifecycle.killWarren` / `restartWarren`.
 * In-proc only until the container launcher exposes equivalent hooks.
 */

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForServerDown } from "../lib/poll.ts";
import { collectRunEvents, waitForEventCount, waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
}

interface CreateRunResponse {
	readonly run: {
		readonly id: string;
		readonly state: string;
		readonly sandboxId: string | null;
		readonly sandboxRunId: string | null;
	};
}

interface RunDetail {
	readonly run: {
		readonly id: string;
		readonly state: string;
		readonly failureReason: string | null;
		readonly sandboxRunId: string | null;
	};
}

interface EventEnvelope {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const PRE_KILL_MIN_EVENTS = 3;
const PRE_KILL_TIMEOUT_MS = 15_000;
const KILL_DRAIN_TIMEOUT_MS = 10_000;
const POST_RESTART_TIMEOUT_MS = 20_000;

export const scenario: Scenario = {
	id: "06",
	title:
		"warren restart reconciles in-flight local runs as sandbox_run_lost; durable events preserved",
	modes: ["in-proc"],
	async run(ctx) {
		const lifecycle = ctx.lifecycle;
		if (lifecycle === undefined) {
			throw new AcceptanceError(
				"scenario 06 requires ctx.lifecycle (killWarren/restartWarren) — harness boot did not wire it",
			);
		}

		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// stub-shell is seeded at boot via WARREN_SEED_AGENTS_FILE (warren-e376).
		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "[sleep_ms=15000] scenario-06 restart recovery",
			},
		});
		const runId = created.run.id;
		assertTrue(
			typeof created.run.sandboxRunId === "string" && created.run.sandboxRunId !== null,
			"POST /runs must attach sandbox_run_id by the 201 — bootBridges reconcile needs it",
		);
		ctx.logger.debug(`scenario-06: spawned ${runId} (sandbox_run_id=${created.run.sandboxRunId})`);

		try {
			// Phase 1 — wait for the bridge to land at least PRE_KILL_MIN_EVENTS
			// events into warren's durable events table. Proves the bridge is
			// actively attached pre-kill and gives us a pre-kill seq set to
			// assert survives the restart.
			const beforeKill = await waitForEventCount<EventEnvelope>(
				http,
				runId,
				PRE_KILL_MIN_EVENTS,
				PRE_KILL_TIMEOUT_MS,
			);
			assertNoSeqGaps(beforeKill, "pre-kill event sequence");
			const maxSeqBeforeKill = beforeKill[beforeKill.length - 1]?.seq ?? 0;
			ctx.logger.debug(
				`scenario-06: pre-kill events=${beforeKill.length} maxSeq=${maxSeqBeforeKill}`,
			);

			// Phase 2 — kill warren. The in-process LocalRunStore dies with
			// it; the agent child is reaped by the OS. On restart there is
			// nothing to re-attach to.
			await lifecycle.killWarren();
			ctx.logger.debug("scenario-06: warren killed; waiting for the port to stop answering");
			await waitForServerDown(ctx.warrenUrl, KILL_DRAIN_TIMEOUT_MS);

			// Phase 3 — restart warren. bootBridges() walks queued/running
			// runs, probes provider.status(), sees exists:false (store wiped),
			// and reconciles the row via reconcileLostSandboxRun.
			await lifecycle.restartWarren();
			ctx.logger.debug("scenario-06: warren restarted; waiting for lost-run reconcile");

			// Phase 4 — the live row must terminalize as failed/sandbox_run_lost.
			// bootBridges does this inline during boot, so the first GET after
			// /healthz is often already terminal; poll anyway for races.
			const terminal = await waitForRunTerminal(http, runId, POST_RESTART_TIMEOUT_MS);
			assertEqual(
				terminal.state,
				"failed",
				"post-restart live row reconciles to state='failed' (local store wiped)",
			);
			assertEqual(
				terminal.failureReason,
				"sandbox_run_lost",
				"post-restart failureReason is sandbox_run_lost (documented LocalProvider posture)",
			);

			const reread = await http.expectJson<RunDetail>(
				"GET",
				`/runs/${encodeURIComponent(runId)}`,
				200,
			);
			// sandbox_run_id is a durable column on the warren row — reconcile
			// does not clear it. Identity of the *provider* run is gone; the
			// warren-side foreign key remains for audit.
			assertEqual(
				reread.run.sandboxRunId,
				created.run.sandboxRunId,
				"GET /runs/:id post-restart preserves the durable sandbox_run_id column",
			);

			// Phase 5 — durable pre-kill events survive; a bridge_lost audit
			// event is appended by reconcileLostSandboxRun.
			const afterRestart = await collectRunEvents<EventEnvelope>(http, runId);
			assertTrue(
				afterRestart.length >= beforeKill.length,
				`post-restart events (${afterRestart.length}) must retain pre-kill rows (${beforeKill.length})`,
			);
			const allSeqs = new Set(afterRestart.map((e) => e.seq));
			for (const env of beforeKill) {
				assertTrue(allSeqs.has(env.seq), `post-restart events lost pre-kill seq ${env.seq}`);
			}
			const bridgeLost = afterRestart.find((e) => e.kind === "bridge_lost");
			if (bridgeLost === undefined) {
				throw new AcceptanceError(
					`no bridge_lost event after restart reconcile; kinds=${afterRestart.map((e) => e.kind).join(",")}`,
				);
			}
			assertEqual(bridgeLost.stream, "system", "bridge_lost event uses stream='system'");
			const payload = (bridgeLost.payload ?? {}) as {
				sandboxRunId?: string;
				reason?: string;
			};
			assertEqual(
				payload.sandboxRunId,
				created.run.sandboxRunId,
				"bridge_lost payload.sandboxRunId matches the spawn-time id",
			);
			assertEqual(
				payload.reason,
				"sandbox_run_lost",
				"bridge_lost payload.reason is sandbox_run_lost",
			);
			ctx.logger.debug(
				`scenario-06: reconciled lost run; events=${afterRestart.length} bridge_lost.seq=${bridgeLost.seq}`,
			);
		} finally {
			await safelyCancel(http, runId, ctx);
		}
	},
};

function assertNoSeqGaps(events: readonly EventEnvelope[], label: string): void {
	if (events.length === 0) {
		throw new AcceptanceError(`${label}: empty event list`);
	}
	const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
	for (let i = 1; i < seqs.length; i++) {
		const prev = seqs[i - 1] ?? 0;
		const cur = seqs[i] ?? 0;
		if (cur !== prev + 1) {
			throw new AcceptanceError(
				`${label}: gap in seq numbers ${prev} → ${cur} at index ${i} (full seqs=${JSON.stringify(seqs)})`,
			);
		}
	}
}

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Earlier scenarios may have left a project clone in place; tolerate
	// either state — the spawn path doesn't care whether it's a fresh row.
	const existing = await http.expectJson<{ projects: (ProjectRow & { gitUrl: string })[] }>(
		"GET",
		"/projects",
		200,
	);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return { id: found.id };
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-06: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort, continuing`,
		);
	}
}
