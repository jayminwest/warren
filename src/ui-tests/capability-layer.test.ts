/**
 * Structural guard for the UI capability layer (warren-f53e / pl-b82d
 * step 19).
 *
 * The acceptance criterion is negative and easy to regress silently: a
 * visitor with no token browses `app.warren.run` and NO dispatch / steer /
 * cancel / refresh / delete affordance is rendered anywhere. The warren UI
 * package ships without a React test harness (no jsdom, no
 * @testing-library, mx-a86ce6), so — same convention as
 * `plot-surface-removed.test.ts` and `ready-plans-tab.test.ts` — the
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
		expect(read("components", "Layout.tsx")).toMatch(
			/setApiToken\(null\);[\s\S]{0,400}qc\.clear\(\)/,
		);
		expect(read("pages", "Login.tsx")).toMatch(/qc\.clear\(\)/);
	});
});

describe("AuthGate lets an anonymous visitor through (warren-f53e)", () => {
	const gate = read("components", "AuthGate.tsx");

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
	const app = read("App.tsx");
	const layout = read("components", "Layout.tsx");

	test("both dispatch forms are wrapped in OperatorRoute", () => {
		for (const page of ["NewRunPage", "NewPlanRunPage"]) {
			expect(app).toMatch(new RegExp(`<OperatorRoute>\\s*<${page} />\\s*</OperatorRoute>`));
		}
	});

	test("OperatorRoute bounces to a surface every caller can read", () => {
		const guard = read("components", "OperatorOnly.tsx");
		expect(guard).toMatch(/<Navigate to="\/runs" replace \/>/);
		// Waits for the answer rather than bouncing an operator mid-load.
		expect(guard).toMatch(/status === "loading"\) return null/);
	});

	test("the cost analytics page and its nav entry are gated together", () => {
		expect(app).toMatch(/<OperatorRoute capability="readOperator">/);
		expect(layout).toMatch(/to: "\/cost-analytics"[^\n]*capability: "readOperator"/);
	});

	test("nav links are filtered by capability and the dispatch CTA is gated", () => {
		expect(layout).toMatch(
			/NAV_ITEMS\.filter\(\s*\(\{ capability \}\) => capability === undefined \|\| caps\.can\(capability\)/,
		);
		expect(layout).toMatch(/<OperatorOnly>\s*<NavLink\s*to="\/runs\/new"/);
	});
});

/**
 * Every file that mutates must import the gate. This is the criterion that
 * actually scales: it fails the moment someone adds a mutation to a page
 * that has no notion of capabilities, without this test needing to know
 * which button the mutation is behind.
 *
 * `mutationFn` is the marker — a `useMutation` is the only way the UI
 * writes. The exemptions are NAMED, not pattern-matched, and each is
 * asserted separately below: `RefreshProjectsCTA.tsx` is a leaf gated by
 * its caller, and `NewRun.tsx` is a whole page guarded at the route (its
 * only reason to exist is the dispatch it submits).
 */
describe("every mutation site sits behind the one gate (warren-f53e)", () => {
	const GATED_ELSEWHERE = new Set(["RefreshProjectsCTA.tsx", "NewRun.tsx"]);

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
		const projects = read("pages", "Projects.tsx");
		expect(projects).toMatch(
			/<OperatorOnly capability="admin">\s*<RefreshProjectsCTA \/>\s*<\/OperatorOnly>/,
		);
	});

	test("the plan-dispatch dialog is gated at its entry point", () => {
		const dialog = read("components", "dispatch-plan-dialog.tsx");
		expect(dialog).toMatch(/<OperatorOnly>\s*<Button type="button" size="sm"/);
	});

	test("project + registry mutation is gated on admin, not dispatch", () => {
		// `POST /projects` and `DELETE /projects/:id` are `admin` in
		// ROUTE_TABLE (warren-b875). The canopy `/agents/refresh` routes were
		// removed in the deletion pass (warren-6fcd), so the Agents page no
		// longer carries an admin mutation control.
		expect(read("pages", "Projects.tsx")).toMatch(
			/<OperatorOnly capability="admin">\s*<AddProjectForm/,
		);
		expect(read("pages", "NewPlanRun.tsx")).toMatch(/<OperatorOnly capability="admin">/);
	});
});

describe("redacted wire fields render on presence (warren-f53e)", () => {
	const types = read("api", "types.ts");
	const client = read("api", "client.ts");
	const runDetail = read("pages", "RunDetail.tsx");

	test("the fields the public projection drops are optional in the row types", () => {
		// `undefined !== null` is TRUE — the exact shape that blanked every
		// run detail page in warren-1f12. Optional forces a presence test.
		expect(types).toMatch(/burrowId\?: string \| null/);
		expect(types).toMatch(/burrowRunId\?: string \| null/);
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

	test("the burrow meta cards don't render as two empty '—' cards", () => {
		expect(runDetail).toMatch(/\{r\.burrowId \? \(/);
		expect(runDetail).toMatch(/\{r\.burrowRunId \? \(/);
		expect(runDetail).not.toMatch(/burrowId \?\? "—"/);
		expect(runDetail).not.toMatch(/burrowRunId \?\? "—"/);
	});

	test("the runs list renders its all-time cost tile on presence", () => {
		const runs = read("pages", "Runs.tsx");
		expect(runs).toMatch(/total: runs\.data\?\.costTotalUsd,/);
		expect(runs).toMatch(/costTotals\.total !== undefined/);
	});

	test("the agents panel reads the flat metadata that survives projection", () => {
		const agents = read("pages", "Agents.tsx");
		expect(agents).toMatch(/agent\.provider \?\?/);
		expect(agents).toMatch(/agent\.model \?\?/);
		// The rendered envelope (system prompt, canopy paths) is dropped for
		// a spectator, so its half of the panel is operator-only.
		expect(agents).toMatch(/<OperatorOnly capability="readOperator">\s*<AgentDefinitionInternals/);
	});

	// warren-e274: `REDACTED_RUN_TOTALS_FIELDS` drops `totals.cost` and
	// `REDACTED_RUN_GROUP_FIELDS` drops `costUsd` / `priced` for a
	// readPublic-only caller, so the UI types must mark them optional and
	// the three consumers must render on presence. Before this fix the whole
	// /run-analytics page threw for an anonymous visitor.
	test("run-analytics cost fields are optional in the wire types", () => {
		expect(client).toMatch(/cost\?: \{ total: number; avg: number \| null; priced: number \}/);
		expect(client).toMatch(/costUsd\?: number;\s*priced\?: number;/);
	});

	test("the run-analytics consumers guard the redacted cost fields", () => {
		const kpi = read("pages", "run-analytics", "KpiCards.tsx");
		const tables = read("pages", "run-analytics", "Tables.tsx");
		const tokenStats = read("pages", "run-analytics", "TokenStats.tsx");
		// KpiCards: the `Total cost` card renders only when `cost` is present.
		expect(kpi).toMatch(/cost !== undefined \?/);
		expect(kpi).not.toMatch(/totals\.cost\.total/);
		// Tables: the `Cost` column is omitted when no bucket carries costUsd.
		expect(tables).toMatch(/buckets\.some\(\(b\) => b\.costUsd !== undefined\)/);
		expect(tables).toMatch(/b\.costUsd === undefined \? "—" : formatCostUsd/);
		// TokenStats: same treatment for the `$/1M` column.
		expect(tokenStats).toMatch(/buckets\.some\(\(b\) => b\.costUsd !== undefined\)/);
		expect(tokenStats).toMatch(/b\.costUsd === undefined \? "—" : costPer1M/);
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
		const guard = read("components", "OperatorOnly.tsx");
		expect(guard).toMatch(/export function useOperatorHint\(/);
		expect(guard).toMatch(/return caps\.can\(capability\) \? hint : undefined;/);
	});

	test("EmptyState drops the description row when the hint is undefined", () => {
		// Not cosmetic, and the reason this is a hook and not an
		// `<OperatorOnly>` inside the slot: that would render nothing but
		// still cost the row's `gap-2`.
		expect(read("components", "ui", "empty-state.tsx")).toMatch(/\{description \? \(/);
	});

	test("the two dispatch lists gate their instruction on `dispatch`", () => {
		for (const page of ["Runs.tsx", "PlanRuns.tsx"]) {
			const src = read("pages", page);
			expect(src).toMatch(/useOperatorHint\("Dispatch one above\."\)/);
			expect(src).toMatch(/description=\{emptyHint\}/);
		}
	});

	test("the projects list gates its instruction on `admin`, like AddProjectForm", () => {
		// `POST /projects` is `admin`, not `dispatch` (warren-b875) — gating
		// the copy on `dispatch` would print it for a caller who still can't
		// see the form.
		const projects = read("pages", "Projects.tsx");
		expect(projects).toMatch(/useOperatorHint\("Add one with a GitHub URL above\.", "admin"\)/);
		expect(projects).toMatch(/description=\{emptyHint\}/);
	});

	/**
	 * The scaling half: gated copy travels as `useOperatorHint("…")` and
	 * reaches the slot as an expression, so a description STRING LITERAL that
	 * points at an on-page control ("… above") is by construction ungated.
	 * That catches a fourth page without this test naming it.
	 *
	 * One named exemption, in the style of `GATED_ELSEWHERE` above:
	 * `ready-plans.tsx` lives inside a `readOperator` tab that `PlanRuns.tsx`
	 * drops for a spectator, so its "choose one above" never reaches one.
	 *
	 * Expression descriptions are outside the guard by design — the Agents
	 * page's copy is a JSX fragment and its spectator issues are tracked
	 * separately.
	 */
	test("no ungated empty-state literal points at an on-page control", () => {
		const GATED_ELSEWHERE = new Set(["ready-plans.tsx"]);
		const offenders: string[] = [];
		for (const file of UI_FILES) {
			const name = file.slice(file.lastIndexOf("/") + 1);
			if (GATED_ELSEWHERE.has(name)) continue;
			const literals = readFileSync(file, "utf8").match(/description="[^"]*"/g) ?? [];
			if (literals.some((literal) => / above/.test(literal))) {
				offenders.push(file.slice(UI_SRC.length + 1));
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("demo polish (warren-f53e)", () => {
	test("the steer form sits above the 480px event tail", () => {
		const runDetail = read("pages", "RunDetail.tsx");
		const steer = runDetail.indexOf("<SteerForm");
		const tail = runDetail.indexOf("<EventTail");
		expect(steer).toBeGreaterThan(-1);
		expect(tail).toBeGreaterThan(-1);
		expect(steer).toBeLessThan(tail);
	});

	test("the plot-era residue is gone from the two files that carried it", () => {
		const cta = read("components", "RefreshProjectsCTA.tsx");
		// Dead cache invalidations for surfaces deleted in pl-3a79.
		expect(cta).not.toMatch(/\["plots"\]/);
		expect(cta).not.toMatch(/\["plot"\]/);
		expect(cta).not.toMatch(/discover new Plots/);
		const status = read("components", "StatusIndicator.tsx");
		expect(status).not.toMatch(/PLOT_STATUS/);
		expect(status).not.toMatch(/^\tplot: /m);
	});
});
