/**
 * Regression guard for the blank-run-detail incident (warren-1f12 /
 * pl-3a79 step 10).
 *
 * What happened: steps 8-9 of the plot deletion pass dropped the
 * `/plots*` routes and the `runs.plot_id` / `plan_runs.plot_id` /
 * `projects.has_plot` columns server-side, but the UI kept rendering a
 * Plot MetaCard behind a `r.plotId !== null` guard. Once the field went
 * absent from the wire, `undefined !== null` evaluated TRUE, the card
 * mounted, and `PlotMetaCardContent` dereferenced `plotId.length` →
 * TypeError during render. With no error boundary mounted, React
 * unmounted the root and every `/#/runs/:id` deep link went blank.
 *
 * The warren UI package ships without a React test harness (no jsdom, no
 * @testing-library, mx-a86ce6), so these are source-level invariants —
 * the same convention as ready-plans-tab.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const UI_SRC = join(import.meta.dir, "..", "ui", "src");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

const UI_FILES = walk(UI_SRC);

describe("plot surface is gone from the UI (warren-1f12)", () => {
	test("no source file references a plot id, plot API, or plot route", () => {
		const offenders: string[] = [];
		for (const file of UI_FILES) {
			const src = readFileSync(file, "utf8");
			// ErrorBoundary.tsx documents the incident in prose — it is the
			// one place the word is allowed, and it ships no plot code.
			if (file.endsWith("error-boundary.tsx")) continue;
			if (/plotId|plotsApi|hasPlot|\/plots\b|PlotStatus|PlotSummary/.test(src)) {
				offenders.push(file.slice(UI_SRC.length + 1));
			}
		}
		expect(offenders).toEqual([]);
	});

	test("RunDetail and PlanRunDetail render no Plot MetaCard", () => {
		const runDetail = readFileSync(join(UI_SRC, "pages", "run-detail", "index.tsx"), "utf8");
		const planRunDetail = readFileSync(join(UI_SRC, "pages", "plan-run-detail.tsx"), "utf8");
		for (const src of [runDetail, planRunDetail]) {
			expect(src).not.toMatch(/PlotMetaCardContent/);
			expect(src).not.toMatch(/label="Plot"/);
		}
	});

	test("the wire row types carry no plotId / hasPlot field", () => {
		const types = readFileSync(join(UI_SRC, "api", "types.ts"), "utf8");
		// The server dropped these columns; a type that still declares them
		// lets `undefined` masquerade as a present value at every guard.
		expect(types).not.toMatch(/\bplotId\b/);
		expect(types).not.toMatch(/\bhasPlot\b/);
	});
});

describe("route-level error boundary (warren-1f12)", () => {
	const boundary = readFileSync(join(UI_SRC, "components", "error-boundary.tsx"), "utf8");
	// warren-4ed7: the routed Outlet moved from the legacy Layout into the
	// Direction C console shell.
	const layout = readFileSync(join(UI_SRC, "components", "console", "console-shell.tsx"), "utf8");

	test("implements the React error-boundary contract", () => {
		// Both halves are required: getDerivedStateFromError swaps in the
		// fallback, componentDidCatch is what puts the component stack in
		// the console so the next incident is diagnosable.
		expect(boundary).toMatch(/static getDerivedStateFromError/);
		expect(boundary).toMatch(/componentDidCatch/);
	});

	test("resets on navigation so a broken page isn't sticky", () => {
		expect(boundary).toMatch(/static getDerivedStateFromProps/);
		expect(boundary).toMatch(/resetKey/);
	});

	test("wraps the routed Outlet inside the Layout chrome", () => {
		// Inside the chrome, not outside: a page-level throw must cost the
		// page, not the sidebar the user needs to navigate away with.
		expect(layout).toMatch(
			/<ErrorBoundary resetKey=\{location\.pathname\}>\s*<Outlet \/>\s*<\/ErrorBoundary>/,
		);
	});
});
