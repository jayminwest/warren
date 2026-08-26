/**
 * Structural guard for the UI capability layer (warren-f53e / pl-b82d
 * step 19).
 *
 * The acceptance criterion is negative and easy to regress silently: a
 * visitor with no token browses `app.warren.run` and NO dispatch / steer /
 * cancel / refresh / delete affordance is rendered anywhere. The warren UI
 * package ships without a React test harness (no jsdom, no
 * @testing-library, mx-a86ce6), so — same convention as
 * `plot-surface-removed.test.ts` and `walk-inventory.test.ts` — the
 * invariants are pinned at the source level:
 *
 *   1. every mutating `useMutation` lives in a file that imports the ONE
 *      gate (`OperatorOnly` / `OperatorRoute`), so a new mutation site
 *      can't be added to an ungated file without this test noticing;
 *   2. `AuthGate` decides from `/whoami`, never from a localStorage token;
 *   3. the two dispatch forms are route-guarded;
 *   4. nav entries whose destination is readOperator carry a capability;
 *   5. no empty-state instruction points a spectator at a control the gate
 *      removed (warren-b67b).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const UI_SRC = join(import.meta.dir, "..", "ui", "src");
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

function read(...parts: string[]): string {
	return readFileSync(join(UI_SRC, ...parts), "utf8");
}

const UI_FILES = walk(UI_SRC);

describe("useCapabilities (warren-f53e)", () => {
	const helpers = read("hooks", "use-capabilities.helpers.ts");
	const hook = read("hooks", "use-capabilities.ts");

	test("reads GET /whoami once per session under a stable key", () => {
		expect(hook).toMatch(/WHOAMI_QUERY_KEY = \["meta", "whoami"\]/);
		expect(hook).toMatch(/metaApi\.whoami\(signal\)/);
		expect(hook).toMatch(/staleTime: Number\.POSITIVE_INFINITY/);
	});

	test("separates the 401 answer from the anonymous answer", () => {
		// The trap warren-e195 called out: under the default
		// WARREN_AUTH=token a tokenless browser 401s on /whoami too, so
		// folding that into "anonymous" would strand the operator on a
		// read-only UI with no route to /login.
		expect(helpers).toMatch(/instanceof UnauthorizedError\) return denied\("unauthenticated"/);
		expect(helpers).toMatch(/"loading" \| "ready" \| "unauthenticated" \| "error"/);
	});

	test("both token-mutating sites clear the cache so the answer is re-asked", () => {
		// warren-4ed7: the logout site moved from the legacy layout.tsx
		// into the console sidebar footer.
		expect(read("components", "console", "console-sidebar.tsx")).toMatch(
			/setApiToken\(null\);[\s\S]{0,400}qc\.clear\(\)/,
		);
		expect(read("pages", "login.tsx")).toMatch(/qc\.clear\(\)/);
	});
});

describe("AuthGate lets an anonymous visitor through (warren-f53e)", () => {
	const gate = read("components", "auth-gate.tsx");

	test("decides from the capability layer, not from a stored token", () => {
		expect(gate).toMatch(/useCapabilities/);
		// The old guard bounced on `getApiToken() === null`, which sends a
		// legitimate public-mode visitor to a password box.
		expect(gate).not.toMatch(/getApiToken/);
	});

	test("redirects to /login only on an actual 401", () => {
		expect(gate).toMatch(/status === "unauthenticated"[\s\S]{0,160}Navigate to="\/login"/);
	});

	test("surfaces a transport failure instead of demoting to read-only", () => {
		expect(gate).toMatch(/status === "error"/);
		expect(gate).toMatch(/title="Can't reach warren"/);
	});
});

describe("route guards and nav filtering (warren-f53e)", () => {
	const app = read("app.tsx");
	const sidebar = read("components", "console", "console-sidebar.tsx");
	const nav = read("components", "console", "console-nav.ts");

	test("both dispatch forms are wrapped in OperatorRoute", () => {
		for (const page of ["DispatchPage", "DispatchPlanPage"]) {
			expect(app).toMatch(new RegExp(`<OperatorRoute>\\s*<${page} />\\s*</OperatorRoute>`));
		}
	});

	test("OperatorRoute bounces to a surface every caller can read", () => {
		const guard = read("components", "operator-only.tsx");
		expect(guard).toMatch(/<Navigate to="\/runs" replace \/>/);
		// Waits for the answer rather than bouncing an operator mid-load.
		expect(guard).toMatch(/status === "loading"\) return null/);
	});

	test("the cost analytics surface and its route gate travel together", () => {
		// warren-4ed7: the legacy /cost-analytics route folded into the
		// Telemetry Economics tab, which keeps the same readOperator guard
		// GET /analytics/cost carries in ROUTE_TABLE (warren-cf63).
		expect(app).toMatch(/<OperatorRoute capability="readOperator">\s*<TelemetryEconomicsTab \/>/);
		expect(app).toMatch(/Navigate to="\/telemetry\/economics"/);
		expect(nav).not.toMatch(/to: "\/cost-analytics"/);
	});

	test("console nav entries declare capability and the sidebar filters on it", () => {
		// An entry whose destination is readOperator never shows to a caller
		// who would only ever see a 403 there. No Direction C entry carries a
		// capability today — this holds the seam for the page issues that
		// land gated destinations.
		expect(nav).toMatch(/readonly capability\?: CapabilityName/);
		expect(sidebar).toMatch(/item\.capability === undefined \|\| caps\.can\(item\.capability\)/);
	});
});

describe("every mutation site sits behind the one gate (warren-f53e)", () => {
	// warren-bbe8 / warren-02bb: the dispatch mutations live in the
	// Direction C page state hooks, route-gated like the legacy forms were.
	const GATED_ELSEWHERE = new Set([
		"refresh-projects-cta.tsx",
		"use-dispatch-state.ts",
		"walk-state.ts",
	]);

	test("no file calls useMutation without importing OperatorOnly", () => {
		const offenders: string[] = [];
		for (const file of UI_FILES) {
			const name = file.slice(file.lastIndexOf("/") + 1);
			if (GATED_ELSEWHERE.has(name)) continue;
			const src = readFileSync(file, "utf8");
			if (!/mutationFn:/.test(src)) continue;
			if (/OperatorOnly/.test(src)) continue;
			offenders.push(file.slice(UI_SRC.length + 1));
		}
		expect(offenders).toEqual([]);
	});

	test("the caller-gated leaf is gated by every one of its callers", () => {
		const projects = read("pages", "projects.tsx");
		expect(projects).toMatch(
			/<OperatorOnly capability="admin">\s*<RefreshProjectsCTA \/>\s*<\/OperatorOnly>/,
		);
	});

	test("the plan-runs dispatch control is gated at its entry point", () => {
		// warren-23b2: the Direction C walk inventory's Dispatch plan link is
		// the page's only operator affordance, wrapped in the one gate.
		const page = read("pages", "plan-runs.tsx");
		expect(page).toMatch(/<OperatorOnly>\s*<Link\s+to="\/dispatch\/plan"/);
	});

	test("project + registry mutation is gated on admin, not dispatch", () => {
		// `POST /projects` and `DELETE /projects/:id` are `admin` in
		// ROUTE_TABLE (warren-b875). The canopy `/agents/refresh` routes were
		// removed in the deletion pass (warren-6fcd), so the Agents page no
		// longer carries an admin mutation control.
		expect(read("pages", "projects.tsx")).toMatch(
			/<OperatorOnly capability="admin">\s*<Button size="sm" onClick=\{\(\) => setAddOpen\(true\)\}>/,
		);
		expect(read("pages", "dispatch-plan.tsx")).toMatch(/<OperatorOnly capability="admin">/);
	});
});

describe("redacted wire fields render on presence (warren-f53e)", () => {
	const types = read("api", "types.ts");
	// warren-8c85: the legacy run detail page split into the Direction C
	// run-detail/ directory; the runtime facts panel owns the sandbox
	// handle rendering now.
	const runDetail = read("pages", "run-detail", "side-panels.tsx");

	test("the fields the public projection drops are optional in the row types", () => {
		// `undefined !== null` is TRUE — the exact shape that blanked every
		// run detail page in warren-1f12. Optional forces a presence test.
		expect(types).toMatch(/sandboxId\?: string \| null/);
		expect(types).toMatch(/sandboxRunId\?: string \| null/);
		expect(types).toMatch(/previewFailureMessage\?: string \| null/);
		expect(types).toMatch(/localPath\?: string/);
		// `AgentRow` is canonical in `src/core/wire.ts` (warren-4253) and
		// re-exported from the UI types module, so its optionality assertion
		// reads the kernel file.
		const wire = readFileSync(join(import.meta.dir, "..", "core", "wire.ts"), "utf8");
		expect(wire).toMatch(/renderedJson\?: unknown/);
		// The instance-wide cost rollup is dropped too (warren-946f), so
		// coalescing it to 0 would print a confident "$0.00 all-time".
		expect(types).toMatch(/costTotalUsd\?: number/);
	});

	test("the burrow meta facts don't render as empty '—' rows", () => {
		// The Direction C Runtime panel (warren-8c85) presence-tests the
		// runtime handle before rendering it.
		expect(runDetail).toMatch(/handle !== null && handle\.length > 0/);
		expect(runDetail).not.toMatch(/sandboxId \?\? "—"/);
		expect(runDetail).not.toMatch(/sandboxRunId \?\? "—"/);
	});

	test("the runs list renders its all-time cost tile on presence", () => {
		const runs = read("pages", "runs.tsx");
		expect(runs).toMatch(/total: runs\.data\?\.costTotalUsd,/);
		expect(runs).toMatch(/costTotals\.total !== undefined/);
	});

	test("the agents registry reads the flat metadata that survives projection", () => {
		const agents = read("pages", "agents.tsx");
		expect(agents).toMatch(/agent\.provider \?\?/);
		expect(agents).toMatch(/agent\.model \?\?/);
		// The rendered envelope (system prompt, cost cap) is dropped for a
		// spectator, so the Direction C registry (warren-db84) reads the
		// cost cap out of `renderedJson` only under a strict narrowing
		// guard — a spectator's cell degrades to "—", never a guess.
		expect(agents).toMatch(/readCostCap/);
		expect(agents).toMatch(/typeof cap === "number" && Number\.isFinite/);
	});

	// warren-e274: `REDACTED_RUN_TOTALS_FIELDS` drops `totals.cost` and
	// `REDACTED_RUN_GROUP_FIELDS` drops `costUsd` / `priced` for a
	// readPublic-only caller, so the UI types must mark them optional and
	// the three consumers must render on presence. Before this fix the whole
	// /run-analytics page threw for an anonymous visitor.
	test("run-analytics cost fields are optional in the wire types", () => {
		// warren-be04: the run-analytics mirror types moved out of client.ts
		// (file-size budget) into ./run-analytics-types.ts, re-exported from
		// client.ts, so the assertion reads the new home.
		const analyticsTypes = read("api", "run-analytics-types.ts");
		expect(analyticsTypes).toMatch(
			/cost\?: \{ total: number; avg: number \| null; priced: number \}/,
		);
		expect(analyticsTypes).toMatch(/costUsd\?: number;\s*priced\?: number;/);
		// The outcome rollup's USD figures are redacted the same way.
		expect(analyticsTypes).toMatch(/costPerMergedPrUsd\?: number \| null/);
	});

	test("the telemetry consumers guard the redacted cost fields", () => {
		// warren-7197: the legacy run-analytics chunks are deleted; the
		// Direction C Telemetry tabs are the consumers now. The metric
		// strip renders cost/merged PR on presence, and the economics tab
		// coalesces the redacted bucket figure to "—" rather than NaN.
		const metrics = read("pages", "telemetry", "telemetry-metrics.tsx");
		const economics = read("pages", "telemetry", "economics-tab.tsx");
		expect(metrics).toMatch(/costPerMergedPr === null \|\| costPerMergedPr === undefined/);
		expect(economics).toMatch(
			/row\.costPerMergedPrUsd === null \|\| row\.costPerMergedPrUsd === undefined/,
		);
	});
});

/**
 * Empty-state copy is capability-aware (warren-b67b).
 *
 * `OperatorOnly` removes the dispatch CTA and the add-project form for a
 * public visitor, but the empty states kept the operator instruction —
 * "Dispatch one above." pointed at nothing, so every empty list on
 * `app.warren.run` was a dead end. The instruction now goes through
 * `useOperatorHint`: an operator keeps it, a spectator gets the (already
 * neutral) title alone.
 */
describe("empty states don't point a spectator at a hidden control (warren-b67b)", () => {
	test("the hint hook yields the copy only for a caller holding the capability", () => {
		const guard = read("components", "operator-only.tsx");
		expect(guard).toMatch(/export function useOperatorHint\(/);
		expect(guard).toMatch(/return caps\.can\(capability\) \? hint : undefined;/);
	});

	test("EmptyState drops the description row when the hint is undefined", () => {
		// Not cosmetic, and the reason this is a hook and not an
		// `<OperatorOnly>` inside the slot: that would render nothing but
		// still cost the row's `gap-2`.
		expect(read("components", "ui", "empty-state.tsx")).toMatch(/\{description \? \(/);
	});

	test("the dispatch lists gate their instruction on `dispatch`", () => {
		// runs.tsx keeps the legacy EmptyState slot; the Direction C walk
		// inventory (warren-23b2) carries its quiet placeholder inline but
		// the hint is still the copy-level gate.
		const runs = read("pages", "runs.tsx");
		expect(runs).toMatch(/useOperatorHint\("Dispatch one above\."\)/);
		expect(runs).toMatch(/description=\{emptyHint\}/);
		const planRuns = read("pages", "plan-runs.tsx");
		expect(planRuns).toMatch(/useOperatorHint\(/);
	});

	test("the projects list gates its instruction on `admin`, like the add-project control", () => {
		// `POST /projects` is `admin`, not `dispatch` (warren-b875) — gating
		// the copy on `dispatch` would print it for a caller who still can't
		// see the control.
		const projects = read("pages", "projects.tsx");
		expect(projects).toMatch(
			/useOperatorHint\("An operator can add one with a GitHub URL\.", "admin"\)/,
		);
		expect(projects).toMatch(/description=\{emptyHint\}/);
	});

	/**
	 * The scaling half: gated copy travels as `useOperatorHint("…")` and
	 * reaches the slot as an expression, so a description STRING LITERAL that
	 * points at an on-page control (“… above”) is by construction ungated.
	 * That catches a fourth page without this test naming it.
	 *
	 * Expression descriptions are outside the guard by design — the Agents
	 * page's copy is a JSX fragment and its spectator issues are tracked
	 * separately.
	 */
	test("no ungated empty-state literal points at an on-page control", () => {
		const offenders: string[] = [];
		for (const file of UI_FILES) {
			const literals = readFileSync(file, "utf8").match(/description="[^"]*"/g) ?? [];
			if (literals.some((literal) => / above/.test(literal))) {
				offenders.push(file.slice(UI_SRC.length + 1));
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("demo polish (warren-f53e)", () => {
	test("the steer form is reachable beside the event tail, not below it", () => {
		// warren-f53e's original fix stacked SteerForm above the 480px
		// tail because steering meant scrolling past the whole log.
		// The Direction C workload inspector (warren-8c85) solves the same
		// problem by layout: the tail is the main column and the steer
		// inbox sits in the always-visible side column.
		const runDetail = read("pages", "run-detail", "index.tsx");
		const aside = runDetail.indexOf("<aside");
		const steer = runDetail.indexOf("<SteerForm");
		const tail = runDetail.indexOf("<EventTail");
		expect(steer).toBeGreaterThan(-1);
		expect(tail).toBeGreaterThan(-1);
		expect(aside).toBeGreaterThan(-1);
		expect(steer).toBeGreaterThan(aside);
	});

	test("the plot-era residue is gone from the two files that carried it", () => {
		const cta = read("components", "refresh-projects-cta.tsx");
		// Dead cache invalidations for surfaces deleted in pl-3a79.
		expect(cta).not.toMatch(/\["plots"\]/);
		expect(cta).not.toMatch(/\["plot"\]/);
		expect(cta).not.toMatch(/discover new Plots/);
		const status = read("components", "status-indicator.tsx");
		expect(status).not.toMatch(/PLOT_STATUS/);
		expect(status).not.toMatch(/^\tplot: /m);
	});
});
