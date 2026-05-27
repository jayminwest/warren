import { describe, expect, test } from "bun:test";
import { WarrenClient } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

// Plan-runs — warren-8ffc.
describe("WarrenClient plan-runs", () => {
	test("createPlanRun POSTs the camelCase body verbatim", async () => {
		let observedUrl: string | undefined;
		let observedBody: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input, init) => {
				observedUrl = String(input);
				observedBody = init?.body as string;
				return jsonResponse(201, {
					planRun: { id: "pr-1", state: "queued" },
					children: [],
				});
			}),
		});
		const res = await c.createPlanRun({
			project: "prj_1",
			planId: "pl-abc",
			agent: "claude-code",
			plotId: "plot-x",
		});
		expect(observedUrl).toBe("https://w.local/plan-runs");
		expect(JSON.parse(observedBody || "{}")).toEqual({
			project: "prj_1",
			planId: "pl-abc",
			agent: "claude-code",
			plotId: "plot-x",
		});
		expect(res.planRun.id).toBe("pr-1");
	});

	test("getPlanRun fetches the detail envelope", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, {
					planRun: { id: "pr-1", state: "running" },
					children: [],
					runs: [],
				});
			}),
		});
		const res = await c.getPlanRun("pr-1");
		expect(observedUrl).toBe("https://w.local/plan-runs/pr-1");
		expect(res.planRun.state).toBe("running");
	});

	test("listPlanRuns forwards project + state filters", async () => {
		let observedUrl: string | undefined;
		const c = new WarrenClient({
			config: { baseUrl: "https://w.local" },
			fetch: stub(async (input) => {
				observedUrl = String(input);
				return jsonResponse(200, { planRuns: [] });
			}),
		});
		await c.listPlanRuns();
		expect(observedUrl).toBe("https://w.local/plan-runs");
		await c.listPlanRuns({ project: "prj_1", state: "running" });
		expect(observedUrl).toBe("https://w.local/plan-runs?project=prj_1&state=running");
	});
});
