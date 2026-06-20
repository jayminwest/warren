/**
 * Structural UI test for the "Ready to dispatch" tab on the Plan runs
 * page (warren-ce62 / pl-3fc4 step 7).
 *
 * The warren UI package (src/ui) intentionally ships without a React
 * test harness (no jsdom, no @testing-library, mx-a86ce6), so the tab
 * + one-click-dispatch behaviour is pinned at the source level: this
 * file readFileSyncs PlanRuns.tsx and ready-plans.tsx and asserts the
 * invariants from pl-3fc4 step 7 that a future regression would break.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_PAGES = join(import.meta.dir, "..", "ui", "src", "pages");
const PLAN_RUNS_SOURCE = readFileSync(join(UI_PAGES, "PlanRuns.tsx"), "utf8");
const READY_PLANS_SOURCE = readFileSync(join(UI_PAGES, "ready-plans.tsx"), "utf8");

describe("PlanRuns 'Ready to dispatch' tab (pl-3fc4 step 7)", () => {
	test("declares a tab toggle between the plan-runs table and the ready view", () => {
		// The two-tab model: existing table vs. ready-plans surface.
		expect(PLAN_RUNS_SOURCE).toMatch(/type PlanRunsTab = "plan-runs" \| "ready"/);
		expect(PLAN_RUNS_SOURCE).toMatch(/\{ label: "Plan runs", value: "plan-runs" \}/);
		expect(PLAN_RUNS_SOURCE).toMatch(/\{ label: "Ready to dispatch", value: "ready" \}/);
		expect(PLAN_RUNS_SOURCE).toMatch(/useState<PlanRunsTab>\("plan-runs"\)/);
	});

	test("renders ReadyPlansView for the ready tab, table otherwise", () => {
		// Tab toggles the body; the ready view receives the selected
		// project (the endpoint is per-project) for plot gating.
		expect(PLAN_RUNS_SOURCE).toMatch(/import \{ ReadyPlansView \} from "\.\/ready-plans\.tsx"/);
		expect(PLAN_RUNS_SOURCE).toMatch(
			/tab === "ready" \? \(\s*<ReadyPlansView projectId=\{projectFilter\} project=\{selectedProject\} \/>/,
		);
	});

	test("state filters are hidden on the ready tab, project select stays", () => {
		// State pills are plan-run specific; the project <select> drives
		// both tabs and must remain mounted.
		expect(PLAN_RUNS_SOURCE).toMatch(/tab === "plan-runs"\s*\?\s*STATE_FILTERS\.map/);
	});
});

describe("ReadyPlansView body (pl-3fc4 step 7)", () => {
	test("fetches projectsApi.readyPlans with a 5s refetch, gated on a project", () => {
		expect(READY_PLANS_SOURCE).toMatch(/queryKey: \["ready-plans", projectId\]/);
		expect(READY_PLANS_SOURCE).toMatch(/projectsApi\.readyPlans\(projectId, signal\)/);
		expect(READY_PLANS_SOURCE).toMatch(/refetchInterval: 5000/);
		expect(READY_PLANS_SOURCE).toMatch(/enabled: hasProject/);
	});

	test("prompts the operator to pick a project when none is selected", () => {
		// The endpoint is per-project — no project means no fetch, prompt
		// instead.
		expect(READY_PLANS_SOURCE).toMatch(/if \(!hasProject\)/);
		expect(READY_PLANS_SOURCE).toMatch(/title="Pick a project"/);
	});

	test("matches the page loading / empty / error conventions", () => {
		expect(READY_PLANS_SOURCE).toMatch(/readyPlans\.isLoading \?/);
		expect(READY_PLANS_SOURCE).toMatch(/<Spinner label="Loading ready plans" \/>/);
		expect(READY_PLANS_SOURCE).toMatch(/readyPlans\.isError \?/);
		expect(READY_PLANS_SOURCE).toMatch(/title="Failed to load ready plans"/);
		expect(READY_PLANS_SOURCE).toMatch(/title="No plans ready to dispatch"/);
	});

	test("renders the plan id, name, status, and open-child count columns", () => {
		expect(READY_PLANS_SOURCE).toMatch(/<TableHead[^>]*>Plan<\/TableHead>/);
		expect(READY_PLANS_SOURCE).toMatch(/<TableHead>Name<\/TableHead>/);
		expect(READY_PLANS_SOURCE).toMatch(/<TableHead[^>]*>Status<\/TableHead>/);
		expect(READY_PLANS_SOURCE).toMatch(/<TableHead[^>]*>Open children<\/TableHead>/);
		expect(READY_PLANS_SOURCE).toMatch(/\{plan\.id\}/);
		expect(READY_PLANS_SOURCE).toMatch(/\{plan\.name \?\? "—"\}/);
		expect(READY_PLANS_SOURCE).toMatch(/\{plan\.status\}/);
		expect(READY_PLANS_SOURCE).toMatch(/\{plan\.openChildCount\}/);
	});

	test("one-click Dispatch opens the dialog pre-filled + locked, plot-gated", () => {
		// Each row's DispatchPlanButton pre-fills + locks the plan id and
		// passes the project; the plot back-link is supplied only when the
		// project has .plot/.
		expect(READY_PLANS_SOURCE).toMatch(
			/import \{ DispatchPlanButton \} from "\.\/conversation-detail\/dispatch-plan-dialog\.tsx"/,
		);
		expect(READY_PLANS_SOURCE).toMatch(/<DispatchPlanButton/);
		expect(READY_PLANS_SOURCE).toMatch(/projectId=\{projectId\}/);
		expect(READY_PLANS_SOURCE).toMatch(/planId=\{plan\.id\}/);
		expect(READY_PLANS_SOURCE).toMatch(/planIdLocked/);
		expect(READY_PLANS_SOURCE).toMatch(/plotId=\{hasPlot \? plan\.id : null\}/);
	});
});
