/**
 * Structural UI test for the Direction C walk inventory (warren-23b2 /
 * pl-7e38 step 6). The page replaced the legacy Plan runs table and the
 * "Ready to dispatch" tab (which moves to the Dispatch plan page,
 * warren-02bb) — this file pins the invariants a regression would break:
 * the canvas column set, the filter bar, the per-row child squares, the
 * token-only theming, and the spectator projection.
 *
 * The warren UI package (src/ui) intentionally ships without a React
 * test harness (no jsdom, no @testing-library, mx-a86ce6), so the
 * assertions read the page sources, mirroring
 * `lifecycle-poll-fallback.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_PAGES = join(import.meta.dir, "..", "ui", "src", "pages");
const read = (file: string): string => readFileSync(join(UI_PAGES, file), "utf8");
const PAGE = read("plan-runs.tsx");
const ROW = read("plan-runs/walk-row.tsx");
const STATE = read("plan-runs/walk-state.ts");

describe("Plan runs walk inventory (warren-23b2 / pl-7e38 step 6)", () => {
	test("keeps the existing plan-runs list API as its data source", () => {
		expect(PAGE).toMatch(/planRunsApi\.list\(/);
		// Server-side filters, not a client re-implementation of them.
		expect(PAGE).toMatch(/state: stateFilter/);
		expect(PAGE).toMatch(/project: projectFilter/);
	});

	test("filters like the run index: state, project, and free-text id search", () => {
		expect(PAGE).toMatch(/Filter by plan or plan-run ID/);
		expect(PAGE).toMatch(/STATE_OPTIONS/);
		expect(PAGE).toMatch(/projectFilter/);
		// The search filter stays client-side over id + planId.
		expect(PAGE).toMatch(/pr\.id\.toLowerCase\(\)\.includes\(q\)/);
	});

	test("the Dispatch plan control is gated for the spectator projection", () => {
		// The only operator affordance on a readPublic list: absent, not
		// disabled (warren-f53e).
		expect(PAGE).toMatch(/<OperatorOnly>\s*<Link\s+to="\/dispatch\/plan"/);
		expect(PAGE).toMatch(/useOperatorHint\(/);
	});

	test("each row renders its children as per-state squares plus a merged count", () => {
		expect(ROW).toMatch(/CHILD_SQUARE_COLOR\[c\.state\]/);
		expect(ROW).toMatch(/childSummary\(state, childRows\)/);
		// The squares key off the child's seq, never the array index.
		expect(ROW).toMatch(/key=\{c\.seq\}/);
	});

	test("child state colours cover the whole wire vocabulary", () => {
		for (const childState of [
			"pending",
			"dispatched",
			"running",
			"pr_open",
			"merged",
			"failed",
			"skipped",
		]) {
			expect(STATE).toContain(`\t${childState}: "var(--color-`);
		}
	});

	test("the plan cell distinguishes plan-source walks from issues walks", () => {
		expect(ROW).toMatch(/planRun\.source === "plan"/);
		expect(ROW).toMatch(/issues\$\{count\}|`issues\$\{count\}`/);
	});

	test("theming uses token variables only — no hardcoded colors", () => {
		for (const source of [PAGE, ROW]) {
			// Any literal hex/rgb color reintroduces a theme that only
			// renders in one of dark or light.
			expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			expect(source).not.toMatch(/rgb\(|rgba\(|oklch\(/);
		}
	});

	test("wire vocabulary is re-exported, never redeclared", () => {
		// PlanRunState / PlanRunChildState come from src/core/wire.ts via
		// @/api/types.ts (the check:wire-types guard owns the re-export
		// chain; this pins that the page never spells a local copy).
		expect(ROW).toMatch(/from "@\/api\/types\.ts"/);
		expect(ROW).not.toMatch(/export type PlanRun(State|ChildState) =/);
		expect(STATE).not.toMatch(/export type PlanRun(State|ChildState) =/);
	});

	test("no summary cards — the table is the product", () => {
		expect(PAGE).not.toMatch(/<Card|CardTitle|KpiCard/);
	});

	test("warren-17d7: redacted spectator fields render as em-dash, never crash", () => {
		// The spectator projection strips maxCostUsd, dispatcherHandle,
		// modelOverride, providerOverride, and failureReason
		// (REDACTED_PLAN_RUN_FIELDS), so these arrive undefined. The row
		// must treat "absent" like "null": `== null`, `?? "—"`, never a
		// `.toFixed()` on undefined.
		expect(ROW).toMatch(/cap == null/);
		expect(ROW).toMatch(/planRun\.dispatcherHandle \?\? "—"/);
		expect(ROW).toMatch(/planRun\.modelOverride != null/);
		// formatCostUsd accepts the widened null|undefined domain.
		expect(ROW).toMatch(/from "@\/pages\/run-detail-format\.ts"/);
	});
});
