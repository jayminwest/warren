/**
 * Scenario 28 — `GET /plots` list + filter and `POST /plots` create
 * (warren-5b8a, pl-9d6a step 7). Closes the loop the per-step unit
 * tests open: warren-7e85 verifies the aggregator's per-project fetch
 * + sort; warren-c167 the `GET /plots` handler shape + `?status=`
 * validation; warren-194e the `POST /plots` handler's hasPlot gate,
 * dispatcher-handle resolution, and cache invalidation. This scenario
 * chains them through a real warren stack with two `.plot/`-enabled
 * fixtures (one Plot each, transitioned to different statuses so
 * recency + status filtering are both exercised) plus the shared
 * sample (no `.plot/`) for the byte-identical-no-Plot promise.
 *
 * Topology: in-proc only, shared boot — no per-scenario stack needed
 * since the wire-level assertions don't require special env knobs.
 *
 * Assertions:
 *   1. After registering two distinct Plot-enabled projects, `GET /plots`
 *      returns exactly 2 entries sorted by `last_event_ts desc`. Project
 *      B is built second and its Plot is additionally transitioned
 *      drafting → ready → active, so its `last_event_ts` strictly
 *      follows project A's `plot_created` event. (warren-7e85 sort
 *      contract; warren-c167 `{plots: [...]}` wire shape.)
 *   2. `GET /plots?status=active` filters to exactly project B's Plot.
 *      (warren-c167 `PLOT_STATUSES` validation + aggregator filter
 *      passthrough.)
 *   3. `POST /plots` against project A creates a new Plot, returns 201
 *      with a `PlotSummary` shape, and the next `GET /plots` includes
 *      the new id (defaults to status=drafting and sits at the top of
 *      the recency sort since its `plot_created` was just emitted).
 *      Cache-invalidation contract: the new Plot lands inside the 5s
 *      TTL without waiting for it to expire (warren-194e step 6).
 *   4. `POST /plots` against the non-`.plot/` sample project returns
 *      400 with `code === "project_lacks_plot"` and the project does
 *      NOT appear in any subsequent `GET /plots` response (warren-194e
 *      step 2).
 *   5. Byte-identical no-Plot promise (CLAUDE.md "opt-in built-in
 *      feature" framing): `GET /runs?project=<noPlot>` is identical
 *      before and after the Plot work, AND a fresh run dispatched on
 *      the no-Plot project carries `plotId=null` on the row and on
 *      every event envelope (mirrors scenario 25's negative path —
 *      keep them in sync if the envelope shape ever grows a new tag).
 *
 * Idempotent teardown: nothing to undo — the two scenario projects are
 * registered under unique `insteadOf` URLs and reused on re-runs
 * (project create is idempotent via the existing GET-then-POST guard).
 * The Plots created by step 3 accumulate across runs; assertions are
 * written as "contains" rather than "equals", and the recency sort
 * promise survives because step 3's new Plot is always the most-recent
 * `plot_created` regardless of how many earlier scenario runs left
 * Plots behind.
 */

import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import {
	buildPlotFixture,
	dispatchAndCancel,
	type ErrorEnvelope,
	type EventEnvelope,
	ensurePlotProject,
	ensureSampleProject,
	PLOT_PROJECT_A_URL,
	PLOT_PROJECT_B_URL,
	type PlotListResponse,
	type PlotSummary,
	sleep,
} from "./28-plot-list-and-create.helpers.ts";

export const scenario: Scenario = {
	id: "28",
	title:
		"Plot list + create roundtrip — GET /plots aggregates + sorts + filters, POST /plots creates and gates on hasPlot, byte-identical /runs surface for non-Plot projects",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
		await http.expectStatus("POST", "/agents/refresh", 200);

		// === Build fixtures ===
		// Project A: one Plot at drafting (just `plot_created`).
		// Project B: one Plot at active (plot_created → ready → active),
		// guaranteed strictly later last_event_ts than A's since the CLI
		// stamps events with wall-clock time and A's init runs first.
		const gitConfigPath = join(ctx.tmp, "git-config");

		const fixtureAPath = join(ctx.tmp, "scenario-28-fixture-a");
		const plotIdA = await buildPlotFixture({
			fixturePath: fixtureAPath,
			sourceFixturePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath,
			redirectUrl: PLOT_PROJECT_A_URL,
			plotName: "scenario-28-a",
			finalStatus: "drafting",
		});

		// Small spacer so A's plot_created and B's plot_created can't
		// share a millisecond on a fast machine — the aggregator's
		// secondary sort breaks ties by id but the contract here is
		// "by recency", so we make recency unambiguous.
		await sleep(50);

		const fixtureBPath = join(ctx.tmp, "scenario-28-fixture-b");
		const plotIdB = await buildPlotFixture({
			fixturePath: fixtureBPath,
			sourceFixturePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath,
			redirectUrl: PLOT_PROJECT_B_URL,
			plotName: "scenario-28-b",
			finalStatus: "active",
		});
		ctx.logger.debug(
			`scenario-28: built fixtures A=${fixtureAPath} (plot=${plotIdA}, drafting), B=${fixtureBPath} (plot=${plotIdB}, active)`,
		);

		// === Register projects ===
		const projectA = await ensurePlotProject(http, PLOT_PROJECT_A_URL);
		const projectB = await ensurePlotProject(http, PLOT_PROJECT_B_URL);
		assertEqual(projectA.hasPlot, true, "project A surfaces hasPlot=true after clone");
		assertEqual(projectB.hasPlot, true, "project B surfaces hasPlot=true after clone");

		const noPlotProject = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);
		// Defensive: the shared sample is built without a `.plot/`
		// directory; hasPlot defaults to false. Tolerate either an
		// explicit `false` or an absent field (older API shapes
		// omitted it on hasPlot=false rows).
		assertTrue(
			noPlotProject.hasPlot !== true,
			`shared sample project ${noPlotProject.id} unexpectedly reports hasPlot=true — scenario-28 baseline requires a no-Plot project`,
		);

		// Snapshot the /runs surface for the no-Plot project BEFORE any
		// plot work so we can prove byte-identical preservation after.
		const runsBefore = await http.expectStatus(
			"GET",
			`/runs?project=${encodeURIComponent(noPlotProject.id)}`,
			200,
		);
		const runsBeforeBody = await runsBefore.text();

		// === Assertion 1: GET /plots aggregates A + B, sorted desc by recency ===
		const list1 = await http.expectJson<PlotListResponse>("GET", "/plots", 200);
		const aRow = list1.plots.find((p) => p.id === plotIdA);
		const bRow = list1.plots.find((p) => p.id === plotIdB);
		if (aRow === undefined || bRow === undefined) {
			throw new AcceptanceError(
				`GET /plots: missing one of scenario-28 plots; expected both ${plotIdA} (A) and ${plotIdB} (B) but saw [${list1.plots.map((p) => p.id).join(", ")}]`,
			);
		}
		assertEqual(aRow.project_id, projectA.id, "plot A's summary carries projectA.id");
		assertEqual(bRow.project_id, projectB.id, "plot B's summary carries projectB.id");
		assertEqual(aRow.status, "drafting", "plot A surfaces status=drafting");
		assertEqual(bRow.status, "active", "plot B surfaces status=active");

		// Recency: B's last_event_ts strictly > A's (B got two extra
		// status_changed events after A's plot_created).
		assertTrue(
			bRow.last_event_ts > aRow.last_event_ts,
			`recency: expected B.last_event_ts > A.last_event_ts, got A=${aRow.last_event_ts} B=${bRow.last_event_ts}`,
		);
		// And the aggregator's emit-order MUST honor desc-by-recency: B
		// appears before A in the merged list.
		const aIdx = list1.plots.findIndex((p) => p.id === plotIdA);
		const bIdx = list1.plots.findIndex((p) => p.id === plotIdB);
		assertTrue(
			bIdx < aIdx,
			`GET /plots sort: expected B (active, newer) before A (drafting, older); got indices A=${aIdx} B=${bIdx} in [${list1.plots.map((p) => p.id).join(", ")}]`,
		);

		// === Assertion 2: ?status=active filters to B only ===
		const listActive = await http.expectJson<PlotListResponse>("GET", "/plots?status=active", 200);
		const activeIds = listActive.plots.map((p) => p.id);
		assertTrue(
			activeIds.includes(plotIdB),
			`?status=active should include plot B (${plotIdB}); got [${activeIds.join(", ")}]`,
		);
		assertTrue(
			!activeIds.includes(plotIdA),
			`?status=active should NOT include plot A (drafting, ${plotIdA}); got [${activeIds.join(", ")}]`,
		);
		for (const p of listActive.plots) {
			assertEqual(p.status, "active", `?status=active row ${p.id} carries status=active`);
		}

		// Bonus: ?status=bogus rejects with 400 (typo guard).
		const bogus = await http.request("GET", "/plots?status=bogus");
		assertEqual(bogus.status, 400, "?status=bogus → 400");

		// === Assertion 3: POST /plots in project A creates ===
		const created = await http.expectJson<PlotSummary>("POST", "/plots", 201, {
			body: {
				project_id: projectA.id,
				name: "scenario-28 created",
				intent: { goal: "scenario-28 acceptance create-plot goal" },
			},
		});
		assertEqual(created.project_id, projectA.id, "created Plot summary carries projectA.id");
		assertEqual(created.status, "drafting", "newly-created Plot starts at status=drafting");
		assertEqual(created.name, "scenario-28 created", "newly-created Plot's name round-trips");
		assertTrue(
			created.intent_goal_preview.includes("scenario-28 acceptance"),
			`newly-created Plot's intent_goal_preview should include the goal text; got '${created.intent_goal_preview}'`,
		);
		assertTrue(
			created.last_event_actor.startsWith("user:"),
			`newly-created Plot's last_event_actor should be user:* (default dispatcher 'operator'); got '${created.last_event_actor}'`,
		);

		// Aggregator cache invalidation: the next GET sees the new id
		// without waiting for the 5s TTL.
		const list2 = await http.expectJson<PlotListResponse>("GET", "/plots", 200);
		const list2Ids = list2.plots.map((p) => p.id);
		assertTrue(
			list2Ids.includes(created.id),
			`POST /plots cache-invalidation: created Plot ${created.id} should appear in the next GET /plots; got [${list2Ids.join(", ")}]`,
		);

		// === Assertion 4: POST /plots on no-Plot project → 400 project_lacks_plot ===
		const rejectRes = await http.request("POST", "/plots", {
			body: { project_id: noPlotProject.id, name: "scenario-28 should-fail" },
		});
		assertEqual(
			rejectRes.status,
			400,
			"POST /plots on project without .plot/ should reject with 400",
		);
		const rejectBody = (await rejectRes.json()) as ErrorEnvelope;
		assertEqual(
			rejectBody.error?.code,
			"project_lacks_plot",
			`POST /plots no-Plot rejection should carry code='project_lacks_plot'; got '${rejectBody.error?.code}'`,
		);

		// And no Plot under the no-Plot project leaked into the list.
		const list3 = await http.expectJson<PlotListResponse>("GET", "/plots", 200);
		for (const p of list3.plots) {
			if (p.project_id === noPlotProject.id) {
				throw new AcceptanceError(
					`GET /plots leaked a row for the no-Plot project ${noPlotProject.id}: ${JSON.stringify(p)}`,
				);
			}
		}

		// === Assertion 5: byte-identical /runs surface for the no-Plot project ===
		const runsAfter = await http.expectStatus(
			"GET",
			`/runs?project=${encodeURIComponent(noPlotProject.id)}`,
			200,
		);
		const runsAfterBody = await runsAfter.text();
		assertEqual(
			runsAfterBody,
			runsBeforeBody,
			"GET /runs?project=<noPlot> body is byte-identical before vs after Plot work",
		);

		// Defensive: dispatch a fresh run on the no-Plot project and
		// confirm the row + event-stream envelopes carry plotId=null.
		// Mirrors scenario 25's negative-path defensive assertion.
		const noPlotRun = await dispatchAndCancel({
			http,
			projectId: noPlotProject.id,
			agentName: ctx.fixtures.stubAgentName,
			promptSuffix: "scenario-28 no-plot baseline",
		});
		assertEqual(noPlotRun.plotId, null, "no-plot dispatch run row plotId is null");

		const envelopes: EventEnvelope[] = [];
		for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(noPlotRun.id)}/events`)) {
			envelopes.push(env as EventEnvelope);
		}
		for (const env of envelopes) {
			if (env.plotId !== null && env.plotId !== undefined) {
				throw new AcceptanceError(
					`no-plot run ${noPlotRun.id}: event seq=${env.seq} kind=${env.kind} carries non-null plotId=${env.plotId}`,
				);
			}
			if (env.kind.startsWith("plot.")) {
				throw new AcceptanceError(
					`no-plot run ${noPlotRun.id}: event seq=${env.seq} carries plot.* kind '${env.kind}' but should be byte-identical to pre-change`,
				);
			}
		}
	},
};
