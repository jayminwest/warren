import { describe, expect, test } from "bun:test";
import { WarrenClient } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

// Plots — warren-8ffc.
describe("WarrenClient plots", () => {
	test("listPlots forwards status + needsAttention into the querystring", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, { plots: [] });
			}),
		});
		await c.listPlots();
		expect(observedUrl).toBe("https://w.local/plots");

		await c.listPlots({ status: "drafting", needsAttention: true });
		expect(observedUrl).toBe("https://w.local/plots?status=drafting&filter=needs_attention");
	});

	test("getPlot fetches the envelope", async () => {
		let observedUrl: string | undefined;
		const envelope = {
			id: "plot-abc",
			name: "My Plot",
			status: "drafting",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [],
			project_id: "prj_1",
			paused_runs: [],
		};
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, envelope);
			}),
		});
		const got = await c.getPlot("plot-abc");
		expect(observedUrl).toBe("https://w.local/plots/plot-abc");
		expect(got.id).toBe("plot-abc");
		expect(got.status).toBe("drafting");
	});

	test("createPlot maps camelCase input onto snake_case wire body", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(201, {
					id: "plot-new",
					name: "My Plot",
					status: "drafting",
					intent_goal_preview: "build it",
					attachments_count: 0,
					last_event_ts: "2026-01-01T00:00:00Z",
					last_event_actor: "user:alice",
					project_id: "prj_1",
				});
			}),
		});
		const summary = await c.createPlot({
			projectId: "prj_1",
			name: "My Plot",
			intent: { goal: "build it" },
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			project_id: "prj_1",
			name: "My Plot",
			intent: { goal: "build it" },
			dispatcher_handle: "user:alice",
		});
		expect(summary.id).toBe("plot-new");
	});

	test("createPlot omits undefined optional fields from the body", async () => {
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (_input, init) => {
				observedBody = init?.body as string;
				return jsonResponse(201, {
					id: "p",
					name: "Untitled Plot",
					status: "drafting",
					intent_goal_preview: "",
					attachments_count: 0,
					last_event_ts: "2026-01-01T00:00:00Z",
					last_event_actor: "user:alice",
					project_id: "prj_1",
				});
			}),
		});
		await c.createPlot({ projectId: "prj_1" });
		expect(JSON.parse(observedBody || "{}")).toEqual({ project_id: "prj_1" });
	});

	test("editPlotIntent posts flat top-level fields with snake_case dispatcher_handle", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(200, {
					id: "plot-x",
					name: "x",
					status: "drafting",
					intent: { goal: "new", non_goals: [], constraints: [], success_criteria: [] },
					attachments: [],
					event_log: [],
					project_id: "prj_1",
					paused_runs: [],
				});
			}),
		});
		await c.editPlotIntent("plot-x", {
			goal: "new",
			non_goals: ["don't"],
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots/plot-x/intent");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			goal: "new",
			non_goals: ["don't"],
			dispatcher_handle: "user:alice",
		});
	});

	test("changePlotStatus posts {next, dispatcher_handle}", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(200, {
					summary: {
						id: "plot-x",
						name: "x",
						status: "ready",
						intent_goal_preview: "",
						attachments_count: 0,
						last_event_ts: "2026-01-01T00:00:00Z",
						last_event_actor: "user:alice",
						project_id: "prj_1",
					},
					event: {
						type: "status_changed",
						actor: "user:alice",
						at: "2026-01-01T00:00:00Z",
						data: { from: "drafting", to: "ready" },
					},
				});
			}),
		});
		const res = await c.changePlotStatus("plot-x", {
			next: "ready",
			dispatcherHandle: "user:alice",
		});
		expect(observedUrl).toBe("https://w.local/plots/plot-x/status");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			next: "ready",
			dispatcher_handle: "user:alice",
		});
		expect(res.summary.status).toBe("ready");
	});

	test("syncPlot POSTs to /plots/:id/sync with no body", async () => {
		let observedUrl: string | undefined;
		let observedMethod: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedMethod = init?.method;
				return jsonResponse(200, { kind: "no_op" });
			}),
		});
		const res = await c.syncPlot("plot-x");
		expect(observedUrl).toBe("https://w.local/plots/plot-x/sync");
		expect(observedMethod).toBe("POST");
		expect(res).toEqual({ kind: "no_op" });
	});
});
