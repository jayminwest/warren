/**
 * Scenario 25 — Plot integration end-to-end roundtrip (warren-4e06, pl-2047
 * step 8). Closes the loop the per-step unit tests open: warren-a8c3 verifies
 * the DB+API surface, warren-e26f the env injection at the burrow.up call,
 * warren-e848 the host-side `run_dispatched` append, warren-7e0f the
 * reap-time merge + mirror; this scenario chains them through a real
 * warren+burrow stack and watches the round-trip.
 *
 * What runs:
 *
 *   1. Build a fresh fixture project with a `.plot/` directory and one
 *      pre-initialized Plot (committed to git), append an `insteadOf`
 *      redirect for it on the shared git-config file, and POST /projects
 *      to clone it into warren's data dir. Verify `hasPlot=true` on the
 *      registered row.
 *
 *   2. Dispatch a run against that project with `plot_id` set on the body.
 *      Wait for `running`, poll until the project's
 *      `.plot/plot-<id>.events.jsonl` carries the host-side
 *      `run_dispatched` append (warren-e848 path: warren's spawn flow opens
 *      a `UserPlotClient` and writes before any sandbox bytes flow).
 *
 *   3. The stub-shell agent — when PLOT_ID is set in its env — echoes both
 *      `PLOT_ID` and `PLOT_ACTOR` to stdout and runs `plot append
 *      --event decision_made --data ...` inside the burrow workspace
 *      (lib/stub-agent/agent.sh additions). Cancel the run so reap merges
 *      the workspace `.plot/` back into the project's persistent `.plot/`
 *      (warren-7e0f) and mirrors the agent-emitted `decision_made` into
 *      warren's event stream as `plot.decision_made` tagged with `plotId`.
 *
 *   4. Assertions on `/runs/:id/events` and on disk:
 *        - host-side `run_dispatched` line is present in the project's
 *          `.plot/plot-<id>.events.jsonl` post-spawn (step 2).
 *        - Hard-required (warren-49d7, pl-95dd step 2): a `text` event
 *          containing `PLOT_ID=<id>` proves warren-e26f's env reached the
 *          sandbox process group; `PLOT_ACTOR=agent:<name>:<runId>` proves
 *          the composed actor string survived intact; `plot.decision_made`
 *          appears with matching `plotId` (mirrored by warren-7e0f); and
 *          the project's `.plot/plot-<id>.events.jsonl` carries the
 *          agent's `decision_made` line after reap. These were
 *          soft-skipped pre-warren-a346 because burrow-cli@0.3.1's
 *          `POST /burrows` handler dropped `body.env`; with burrow-59cd
 *          shipped and the burrow-cli pin bumped (warren-0a6b), the
 *          contract is enforced unconditionally so any future regression
 *          fails CI loudly.
 *
 *   5. Negative path — dispatch a run on the EXISTING `.plot`-less sample
 *      project WITHOUT a `plot_id`. Assert no event on the stream has a
 *      `plot.*` kind, no `plot_run_dispatched_failed` is recorded, and
 *      no event envelope carries a non-null `plotId` tag. This is the
 *      "byte-identical to pre-change behavior" promise — Plot integration
 *      is opt-in by gating on `project.hasPlot` AND the per-run `plot_id`.
 *      Defensive corollary: the stub agent's `PLOT_ID=` echo line MUST
 *      NOT appear on a no-plot run, since the agent.sh branch is env-gated.
 *
 * In-proc only — the test pokes at the host-side project clone's `.plot/`
 * directly, which container mode wouldn't surface.
 *
 * warren-3c40 caveat (shared with scenarios 09/10): wait for `state=running`
 * before cancel so reap doesn't misclassify as `never_started`.
 *
 * warren-dcf3 caveat: branch_push will fail against the non-bare local
 * fixture; reap_failed step=branch_push is tolerated.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import {
	buildPlotFixture,
	dispatchAndCancel,
	type EventRow,
	ensureSampleProject,
	fetchAllEvents,
	findTextEvent,
	listTextEvents,
	PLOT_PROJECT_URL,
	type ProjectRow,
	summariseKinds,
	waitForFileLineMatching,
} from "./25-plot-roundtrip.helpers.ts";

export const scenario: Scenario = {
	id: "25",
	title:
		"Plot integration roundtrip — env reaches sandbox, agent append mirrors via reap, no-plot path unchanged",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
		await http.expectStatus("POST", "/agents/refresh", 200);

		// Build a Plot-enabled fixture next to the shared one. The fixture
		// re-uses the existing sample's stub-agent.sh + burrow.toml so the
		// stub-shell agent is already wired up; the only delta is the
		// committed `.plot/` directory with one pre-init Plot.
		const fixturePath = join(ctx.tmp, "scenario-25-fixture");
		const plotId = await buildPlotFixture({
			fixturePath,
			sourceFixturePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath: join(ctx.tmp, "git-config"),
			redirectUrl: PLOT_PROJECT_URL,
		});
		ctx.logger.debug(`scenario-25: built plot fixture at ${fixturePath} with plotId=${plotId}`);

		// Register the project. The post-clone refresh detects `.plot/` and
		// sets hasPlot=true (warren-4e20). The POST response carries the
		// fully-populated row including the freshly-detected feature flag;
		// there is no GET /projects/:id today, so the POST body is the
		// source of truth for hasPlot + localPath.
		const plotProject = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: PLOT_PROJECT_URL },
		});
		assertEqual(
			plotProject.hasPlot,
			true,
			"plot fixture project surfaces hasPlot=true after clone (warren-4e20)",
		);

		// === Plot run ===
		const plotRun = await dispatchAndCancel({
			http,
			projectId: plotProject.id,
			agentName: ctx.fixtures.stubAgentName,
			plotId,
			promptSuffix: "scenario-25 plot run",
		});

		// Host-side `run_dispatched` lands on the project's .plot/ at spawn
		// time (warren-e848). Poll until it's there — the appender fires
		// after attachBurrow and may race with our first read.
		const projectPlotEventsPath = join(plotProject.localPath, ".plot", `${plotId}.events.jsonl`);
		await waitForFileLineMatching(
			projectPlotEventsPath,
			(line) =>
				line.includes(`"type":"run_dispatched"`) && line.includes(`"run_id":"${plotRun.id}"`),
			8_000,
			`run_dispatched event for run ${plotRun.id} on ${projectPlotEventsPath}`,
		);

		// Fetch the full event tail for the run. Reap runs inline on cancel
		// (mx-bade10) so by the time `waitForTerminal` returns we've already
		// merged + mirrored.
		const plotEvents = await fetchAllEvents(http, plotRun.id);

		// Hard-required (warren-49d7, pl-95dd step 2): with burrow-59cd shipped
		// and the burrow-cli pin bumped (warren-0a6b), burrow's POST /burrows
		// handler parses body.env into BurrowUpInput.envOverrides, so PLOT_ID
		// and PLOT_ACTOR reach the sandbox process group. The four assertions
		// below — env echo, actor echo, agent plot append, reap mirror — now
		// run unconditionally; any future regression in that contract fails
		// CI loudly here.
		const echoed = findTextEvent(plotEvents, `PLOT_ID=${plotId}`);
		if (echoed === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: missing PLOT_ID=${plotId} echo on stream — burrow did not forward body.env into the sandbox (warren-a346/burrow-59cd regression?); got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const expectedActorPrefix = `PLOT_ACTOR=agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`;
		const echoedActor = findTextEvent(plotEvents, expectedActorPrefix);
		if (echoedActor === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: missing ${expectedActorPrefix} echo on stream — PLOT_ACTOR did not reach the sandbox; got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const plotOk = findTextEvent(plotEvents, "plot append decision_made OK");
		if (plotOk === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: env reached the sandbox but 'plot append decision_made' did not succeed; got text events: ${listTextEvents(plotEvents)}`,
			);
		}
		const mirrored = plotEvents.find(
			(e) => e.kind === "plot.decision_made" && (e.payload?.plotId ?? null) === plotId,
		);
		if (mirrored === undefined) {
			throw new AcceptanceError(
				`plot run ${plotRun.id}: env reached the sandbox and plot append succeeded, but reap did not mirror plot.decision_made for plotId=${plotId}; got kinds: ${summariseKinds(plotEvents)}`,
			);
		}
		assertEqual(
			mirrored.payload?.actor,
			`agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`,
			"mirrored plot.decision_made carries the agent actor warren-e26f composed",
		);

		// Post-reap disk verification — the project's persistent
		// .plot/plot-<id>.events.jsonl now carries the agent's decision_made
		// line in addition to the host-side run_dispatched.
		const projectPlotEventsAfter = await readFile(projectPlotEventsPath, "utf8");
		assertTrue(
			projectPlotEventsAfter.includes(`"type":"decision_made"`) &&
				projectPlotEventsAfter.includes(`agent:${ctx.fixtures.stubAgentName}:${plotRun.id}`),
			`project .plot file ${projectPlotEventsPath} missing agent decision_made entry after reap; body: ${projectPlotEventsAfter}`,
		);

		// === Byte-identical no-plot path ===
		// Dispatch against the EXISTING sample (no .plot/) WITHOUT plot_id.
		// No plot.* events, no plot_run_dispatched_failed, and every event
		// envelope on the stream must carry plotId=null.
		const sampleProject = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		const noPlotRun = await dispatchAndCancel({
			http,
			projectId: sampleProject.id,
			agentName: ctx.fixtures.stubAgentName,
			promptSuffix: "scenario-25 no-plot baseline",
		});
		assertEqual(noPlotRun.plotId, null, "no-plot dispatch run row plotId is null");

		const noPlotEvents = await fetchAllEvents(http, noPlotRun.id);
		const plotKinds = noPlotEvents.filter(
			(e) => e.kind.startsWith("plot.") || e.kind === "plot_run_dispatched_failed",
		);
		if (plotKinds.length > 0) {
			throw new AcceptanceError(
				`no-plot run ${noPlotRun.id} contained plot.* events but should be byte-identical to pre-change behavior: ${plotKinds.map((e) => e.kind).join(", ")}`,
			);
		}

		// Stream-envelope plotId tag — the NDJSON path tags every row with
		// the run's plotId (warren-a8c3). For a no-plot dispatch this must
		// be null on every envelope.
		const envelopes: EventRow[] = [];
		for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(noPlotRun.id)}/events`)) {
			envelopes.push(env as EventRow);
		}
		for (const env of envelopes) {
			if (env.plotId !== null && env.plotId !== undefined) {
				throw new AcceptanceError(
					`no-plot run ${noPlotRun.id}: event seq=${env.seq} kind=${env.kind} carries non-null plotId=${env.plotId}`,
				);
			}
		}

		// Also: the stub agent's PLOT_ID echo should NOT fire when env is
		// absent — a defensive check that env-gating in the agent is intact.
		const leakedEcho = noPlotEvents.find(
			(e) =>
				e.kind === "text" &&
				typeof e.payload?.text === "string" &&
				(e.payload.text as string).startsWith("stub-agent: PLOT_ID="),
		);
		if (leakedEcho !== undefined) {
			throw new AcceptanceError(
				`no-plot run ${noPlotRun.id}: stub-agent emitted a 'PLOT_ID=' echo even though no plot_id was dispatched; payload=${JSON.stringify(leakedEcho.payload)}`,
			);
		}
	},
};
