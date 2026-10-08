import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { PAGES } from "../ui-visual/pages.ts";
import {
	allPagesScope,
	isInert,
	PAGE_SOURCES,
	pagesForFile,
	scopeForFiles,
	touchesUi,
} from "./scope.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const ALL = PAGES.map((p) => p.id);

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

describe("pagesForFile", () => {
	test("maps a page file, its folder, and its dotted and dashed siblings to the page", () => {
		expect(pagesForFile("src/ui/src/pages/runs.tsx")).toEqual(["runs"]);
		expect(pagesForFile("src/ui/src/pages/runs/runs-table.tsx")).toEqual(["runs"]);
		expect(pagesForFile("src/ui/src/pages/project-detail.panels.tsx")).toEqual(["project-detail"]);
		expect(pagesForFile("src/ui/src/pages/project-detail-layout.ts")).toEqual(["project-detail"]);
		expect(pagesForFile("src/ui/src/pages/event-explorer-format.ts")).toEqual(["events"]);
	});

	test("keeps near-namesakes apart", () => {
		expect(pagesForFile("src/ui/src/pages/run-detail/index.tsx")).toEqual(["run-detail"]);
		expect(pagesForFile("src/ui/src/pages/plan-runs/walk-row.tsx")).toEqual(["plan-runs"]);
		expect(pagesForFile("src/ui/src/pages/plan-run-detail.tsx")).toEqual(["plan-run-detail"]);
		expect(pagesForFile("src/ui/src/pages/dispatch-plan/walk-form.tsx")).toEqual(["dispatch-plan"]);
		expect(pagesForFile("src/ui/src/pages/dispatch/dispatch-form.tsx")).toEqual(["dispatch"]);
	});

	test("maps a telemetry tab to its page and shared telemetry code to all four", () => {
		expect(pagesForFile("src/ui/src/pages/telemetry/loop-tab.buckets.ts")).toEqual([
			"telemetry-loop",
		]);
		expect(pagesForFile("src/ui/src/pages/telemetry/economics-panels.tsx")).toEqual([
			"telemetry-economics",
		]);
		expect(pagesForFile("src/ui/src/pages/telemetry/meter-bar.tsx")).toHaveLength(4);
		expect(pagesForFile("src/ui/src/pages/telemetry.tsx")).toHaveLength(4);
	});

	test("returns null (every page) for shared code and unknown page files", () => {
		expect(pagesForFile("src/ui/src/components/ui/button.tsx")).toBeNull();
		expect(pagesForFile("src/ui/src/tokens.css")).toBeNull();
		expect(pagesForFile("src/ui/src/pages/brand-new-page.tsx")).toBeNull();
	});
});

describe("scopeForFiles", () => {
	test("orders pages as the manifest does and ignores files outside src/ui", () => {
		const scope = scopeForFiles([
			"src/ui/src/pages/telemetry/loop-tab.tsx",
			"src/ui/src/pages/runs.tsx",
			"src/server/main.ts",
		]);
		expect(scope).toEqual({
			pages: ["runs", "telemetry-loop"],
			allPages: false,
			files: ["src/ui/src/pages/telemetry/loop-tab.tsx", "src/ui/src/pages/runs.tsx"],
		});
	});

	test("widens to every page when a shared file changes", () => {
		const scope = scopeForFiles(["src/ui/src/pages/runs.tsx", "src/ui/src/hooks/use-now.ts"]);
		expect(scope.allPages).toBe(true);
		expect(scope.pages).toEqual(ALL);
	});

	test("finds nothing to render in tests and prose", () => {
		const files = ["src/ui/src/pages/runs/runs-format.test.ts", "src/ui/README.md"];
		expect(touchesUi(files)).toBe(true);
		expect(files.every(isInert)).toBe(true);
		expect(scopeForFiles(files).pages).toEqual([]);
	});

	test("allPagesScope covers the whole manifest", () => {
		expect(allPagesScope(["x"])).toEqual({ pages: ALL, allPages: true, files: ["x"] });
	});
});

describe("PAGE_SOURCES", () => {
	test("names only manifest pages and reaches every one", () => {
		const named = new Set(PAGE_SOURCES.flatMap(([, pages]) => pages));
		expect([...named].filter((p) => !ALL.includes(p))).toEqual([]);
		expect(ALL.filter((p) => !named.has(p))).toEqual([]);
	});

	test("maps every rendered file under src/ui/src/pages to a page, not the fallback", () => {
		const root = join(REPO_ROOT, "src/ui/src/pages");
		const unmapped = walk(root)
			.map((abs) => `src/ui/src/pages/${abs.slice(root.length + 1)}`)
			.filter((path) => !isInert(path) && pagesForFile(path) === null);
		expect(unmapped).toEqual([]);
	});
});
