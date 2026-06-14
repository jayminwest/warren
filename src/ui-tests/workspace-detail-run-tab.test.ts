/**
 * Structural UI test for the Workspace detail Run tab (pl-0008 step 9 /
 * warren-d17f).
 *
 * The warren UI package (src/ui) ships without a React test harness (no jsdom,
 * mx-a86ce6), so the Run tab's acceptance criteria are pinned at the source
 * level: it resolves the dispatched plan-run from the Plot via the plan-run
 * `plotId` back-link, reuses the shared `PlanRunChildTable` content (children
 * list + per-child PR-merge status + terminal state), and surfaces the Plot's
 * §11.P auto-done transition when the final child merges.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB_PATH = join(
	import.meta.dir,
	"..",
	"ui",
	"src",
	"pages",
	"workspace-detail",
	"run-tab.tsx",
);
const TAB_SOURCE = readFileSync(TAB_PATH, "utf8");

const PAGE_PATH = join(import.meta.dir, "..", "ui", "src", "pages", "WorkspaceDetail.tsx");
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

describe("WorkspaceDetail Run tab (warren-d17f)", () => {
	test("is wired into the tabbed shell", () => {
		expect(PAGE_SOURCE).toContain('from "@/pages/workspace-detail/run-tab.tsx"');
		expect(PAGE_SOURCE).toMatch(/activeTab === "run" && <RunTab/);
	});

	test("resolves the dispatched plan-run from the Plot via the plotId back-link", () => {
		expect(TAB_SOURCE).toMatch(/planRunsApi\.list\(\{\s*project:\s*plot\.project_id\s*\}/);
		expect(TAB_SOURCE).toMatch(/pr\.plotId === plot\.id/);
	});

	test("reuses the shared PlanRunChildTable content", () => {
		expect(TAB_SOURCE).toContain("PlanRunChildTable");
		expect(TAB_SOURCE).toContain('from "@/pages/plan-run-detail/child-table.tsx"');
	});

	test("surfaces the Plot auto-done transition when the final child merges", () => {
		expect(TAB_SOURCE).toContain("PlotAutoDoneNotice");
		expect(TAB_SOURCE).toMatch(/plot\.status === "done"/);
		expect(TAB_SOURCE).toMatch(/c\.prMergedAt !== null/);
	});

	test("links out to the full plan-run detail", () => {
		expect(TAB_SOURCE).toMatch(/\/plan-runs\/\$\{encodeURIComponent\(head\.id\)\}/);
	});
});
