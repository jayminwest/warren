import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FixtureIds } from "./fixture-data.ts";
import {
	expandManifest,
	PAGES,
	type PageSpec,
	parseCaseFilter,
	screenRoutesFromAppSource,
	THEMES,
	VIEWPORTS,
	validateManifest,
} from "./pages.ts";

/** The slice of the ids contract the manifest reads, with fixture-shaped values. */
const IDS = {
	projects: {
		withSeeds: { id: "prj_fx0000000001", name: "warren-acceptance/sample" },
		withoutSeeds: { id: "prj_fx0000000002", name: "warren-acceptance/docs-site" },
	},
	runs: {
		queued: "run_fx0000000101",
		running: "run_fx0000000102",
		succeeded: "run_fx0000000103",
		failed: "run_fx0000000104",
		cancelled: "run_fx0000000105",
		prOpen: "run_fx0000000106",
	},
	planRun: { id: "plnr_fx0000000001", planId: "pl-fx01", children: [] },
} as unknown as FixtureIds;

const APP_TSX = join(import.meta.dir, "..", "..", "src", "ui", "src", "app.tsx");

describe("PAGES", () => {
	test("passes validation against fixture ids", () => {
		expect(validateManifest(PAGES, IDS)).toEqual([]);
	});

	test("covers every screen route app.tsx declares, and nothing else", () => {
		const routes = screenRoutesFromAppSource(readFileSync(APP_TSX, "utf8"));
		expect(routes.length).toBeGreaterThanOrEqual(18);
		expect([...new Set(PAGES.map((p) => p.route))].sort()).toEqual([...routes].sort());
	});

	test("resolves detail routes to the fixture's seeded ids", () => {
		const byId = new Map(PAGES.map((p) => [p.id, p.path(IDS)]));
		expect(byId.get("run-detail")).toBe("/runs/run_fx0000000102");
		expect(byId.get("plan-run-detail")).toBe("/plan-runs/plnr_fx0000000001");
		expect(byId.get("project-detail")).toBe("/projects/prj_fx0000000001");
	});

	test("visits login anonymously and every other page with the token", () => {
		const anonymous = PAGES.filter((p) => p.authenticated === false).map((p) => p.id);
		expect(anonymous).toEqual(["login"]);
	});
});

describe("validateManifest", () => {
	const page = (over: Partial<PageSpec>): PageSpec => ({
		id: "runs",
		route: "/runs",
		path: () => "/runs",
		...over,
	});

	test("rejects non-kebab and duplicate ids", () => {
		const errors = validateManifest([page({ id: "Runs" }), page({}), page({})], IDS);
		expect(errors).toContain("Runs: id must be kebab-case");
		expect(errors).toContain("runs: duplicate id");
	});

	test("rejects a path carrying the hash or an unresolved param", () => {
		const errors = validateManifest(
			[page({ id: "a", path: () => "/#/runs" }), page({ id: "b", path: () => "/runs/:id" })],
			IDS,
		);
		expect(errors.some((e) => e.startsWith("a: path must be a hash-router path"))).toBe(true);
		expect(errors).toContain('b: path "/runs/:id" has an unresolved param');
	});

	test("rejects a relative route", () => {
		expect(validateManifest([page({ route: "runs" })], IDS)).toEqual([
			'runs: route must start with "/"',
		]);
	});
});

describe("expandManifest", () => {
	test("crosses every page with both viewports and both themes", () => {
		const cases = expandManifest(PAGES, IDS);
		expect(cases).toHaveLength(PAGES.length * 2 * THEMES.length);
		expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
	});

	test("names cases page.viewport.theme and builds hash URLs", () => {
		const [first] = expandManifest(PAGES.slice(0, 1), IDS);
		expect(first?.name).toBe("operations.desktop.light");
		expect(first?.url).toBe("/#/operations");
		expect(first?.size).toEqual(VIEWPORTS.desktop);
	});

	test("applies the page, viewport, and theme filter", () => {
		const cases = expandManifest(PAGES, IDS, {
			pages: ["runs", "agents"],
			viewports: ["phone"],
			themes: ["dark"],
		});
		expect(cases.map((c) => c.name)).toEqual(["runs.phone.dark", "agents.phone.dark"]);
	});
});

describe("parseCaseFilter", () => {
	test("returns an empty filter when no knob is set", () => {
		expect(parseCaseFilter({})).toEqual({
			pages: undefined,
			viewports: undefined,
			themes: undefined,
		});
	});

	test("splits and trims comma lists", () => {
		const filter = parseCaseFilter({
			WARREN_UI_VISUAL_PAGES: " runs , login ",
			WARREN_UI_VISUAL_VIEWPORTS: "phone",
			WARREN_UI_VISUAL_THEMES: "",
		});
		expect(filter).toEqual({ pages: ["runs", "login"], viewports: ["phone"], themes: undefined });
	});

	test("throws on an unknown name instead of running zero cases", () => {
		expect(() => parseCaseFilter({ WARREN_UI_VISUAL_THEMES: "sepia" })).toThrow(
			"WARREN_UI_VISUAL_THEMES: unknown sepia",
		);
	});
});

describe("screenRoutesFromAppSource", () => {
	test("joins relative children, skips redirects, the catch-all, and layouts", () => {
		const src = `
			<Route path="/login" element={<LoginPage />} />
			<Route path="/runs/new" element={<Navigate to="/dispatch" replace />} />
			<Route
				path="/dispatch"
				element={
					<OperatorRoute>
						<DispatchPage />
					</OperatorRoute>
				}
			/>
			<Route path="/telemetry" element={<TelemetryPage />}>
				<Route index element={<TelemetryIndexRedirect />} />
				<Route path="loop" element={<TelemetryLoopTab />} />
			</Route>
			<Route path="*" element={<Navigate to="/operations" replace />} />`;
		expect(screenRoutesFromAppSource(src)).toEqual(["/login", "/dispatch", "/telemetry/loop"]);
	});
});
