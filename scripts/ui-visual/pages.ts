/**
 * The ui-visual page manifest (warren-99e1, plan pl-10db step 8).
 *
 * One `PageSpec` per screen the SPA renders (every screen route in
 * `src/ui/src/app.tsx`), crossed with `VIEWPORTS` and `THEMES` by
 * `expandManifest` into the `PageCase` list every browser spec iterates.
 * The smoke spec (`smoke.pw.ts`) asserts on each case; the golden
 * screenshots (warren-a132) and the axe pass (warren-b629) walk the same
 * list, so a page added here is covered by every layer at once.
 *
 * This module is pure (type-only import of the fixture ids) so both the
 * Playwright runner (Node) and `bun test` can load it.
 */

import type { FixtureIds } from "./fixture-data.ts";

export const VIEWPORTS = {
	desktop: { width: 1440, height: 900 },
	phone: { width: 393, height: 852 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as readonly ViewportName[];

/** Applied through localStorage `warren.theme` before the SPA boots. */
export const THEMES = ["light", "dark"] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * Selector masked in every screenshot. Mark a wall-clock value in the UI
 * with `data-visual-mask` instead of listing it per page.
 */
export const GLOBAL_MASK_SELECTOR = "[data-visual-mask]";

export interface PageSpec {
	/** Stable kebab-case id: the screenshot and golden file stem. */
	readonly id: string;
	/** The `app.tsx` route pattern this entry renders (the coverage key). */
	readonly route: string;
	/** Hash path (no `#`) resolved against the fixture's fixed ids. */
	readonly path: (ids: FixtureIds) => string;
	/** Seed the operator token into localStorage. Default true. */
	readonly authenticated?: boolean;
	/** Extra selectors masked in screenshots, beyond `GLOBAL_MASK_SELECTOR`. */
	readonly mask?: readonly string[];
}

/** One manifest entry at one viewport in one theme. */
export interface PageCase {
	/** `<page id>.<viewport>.<theme>`: the test title and screenshot stem. */
	readonly name: string;
	readonly page: PageSpec;
	readonly viewport: ViewportName;
	readonly size: { readonly width: number; readonly height: number };
	readonly theme: ThemeName;
	/** URL path relative to the fixture base URL, e.g. `/#/runs`. */
	readonly url: string;
}

const at = (path: string) => (): string => path;

/** `<page id>.<viewport>.<theme>`: a case's test title, screenshot stem, and golden stem. */
export function caseName(pageId: string, viewport: ViewportName, theme: ThemeName): string {
	return `${pageId}.${viewport}.${theme}`;
}

/** Every screen route in `src/ui/src/app.tsx`, in nav order. */
export const PAGES: readonly PageSpec[] = [
	{ id: "operations", route: "/operations", path: at("/operations") },
	{ id: "runs", route: "/runs", path: at("/runs") },
	{ id: "run-detail", route: "/runs/:id", path: (ids) => `/runs/${ids.runs.running}` },
	{ id: "dispatch", route: "/dispatch", path: at("/dispatch") },
	{ id: "dispatch-plan", route: "/dispatch/plan", path: at("/dispatch/plan") },
	{ id: "plan-runs", route: "/plan-runs", path: at("/plan-runs") },
	{
		id: "plan-run-detail",
		route: "/plan-runs/:id",
		path: (ids) => `/plan-runs/${ids.planRun.id}`,
	},
	{ id: "projects", route: "/projects", path: at("/projects") },
	{
		id: "project-detail",
		route: "/projects/:id",
		path: (ids) => `/projects/${ids.projects.withSeeds.id}`,
	},
	{ id: "agents", route: "/agents", path: at("/agents") },
	{ id: "telemetry-loop", route: "/telemetry/loop", path: at("/telemetry/loop") },
	{ id: "telemetry-behavior", route: "/telemetry/behavior", path: at("/telemetry/behavior") },
	{ id: "telemetry-judge", route: "/telemetry/judge", path: at("/telemetry/judge") },
	{ id: "telemetry-economics", route: "/telemetry/economics", path: at("/telemetry/economics") },
	{ id: "events", route: "/events", path: at("/events") },
	{ id: "instance", route: "/instance", path: at("/instance") },
	{ id: "setup", route: "/setup", path: at("/setup") },
	{ id: "login", route: "/login", path: at("/login"), authenticated: false },
];

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structural problems in a manifest; empty when it is well-formed. */
export function validateManifest(pages: readonly PageSpec[], ids: FixtureIds): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const page of pages) {
		if (!KEBAB_ID.test(page.id)) errors.push(`${page.id}: id must be kebab-case`);
		if (seen.has(page.id)) errors.push(`${page.id}: duplicate id`);
		seen.add(page.id);
		if (!page.route.startsWith("/")) errors.push(`${page.id}: route must start with "/"`);
		const path = page.path(ids);
		if (!path.startsWith("/") || path.includes("#")) {
			errors.push(`${page.id}: path must be a hash-router path like "/runs", got "${path}"`);
		}
		if (path.includes(":")) errors.push(`${page.id}: path "${path}" has an unresolved param`);
	}
	return errors;
}

/** Cross pages x viewports x themes, in a stable order. */
export function expandManifest(
	pages: readonly PageSpec[],
	ids: FixtureIds,
	filter: CaseFilter = {},
): PageCase[] {
	const keep = (allowed: readonly string[] | undefined, name: string): boolean =>
		allowed === undefined || allowed.includes(name);
	return pages
		.filter((page) => keep(filter.pages, page.id))
		.flatMap((page) =>
			VIEWPORT_NAMES.filter((v) => keep(filter.viewports, v)).flatMap((viewport) =>
				THEMES.filter((t) => keep(filter.themes, t)).map((theme) => ({
					name: caseName(page.id, viewport, theme),
					page,
					viewport,
					size: VIEWPORTS[viewport],
					theme,
					url: `/#${page.path(ids)}`,
				})),
			),
		);
}

export interface CaseFilter {
	readonly pages?: readonly string[];
	readonly viewports?: readonly string[];
	readonly themes?: readonly string[];
}

/**
 * Parse the comma-separated `WARREN_UI_VISUAL_PAGES` / `_VIEWPORTS` /
 * `_THEMES` env knobs into a filter, rejecting unknown names so a typo
 * never silently runs zero cases.
 */
export function parseCaseFilter(
	env: Readonly<Record<string, string | undefined>>,
	pages: readonly PageSpec[] = PAGES,
): CaseFilter {
	const pick = (key: string, known: readonly string[]): readonly string[] | undefined => {
		const raw = env[key]?.trim();
		if (raw === undefined || raw === "") return undefined;
		const names = raw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== "");
		const unknown = names.filter((n) => !known.includes(n));
		if (unknown.length > 0) {
			throw new Error(`${key}: unknown ${unknown.join(", ")}; known: ${known.join(", ")}`);
		}
		return names;
	};
	return {
		pages: pick(
			"WARREN_UI_VISUAL_PAGES",
			pages.map((x) => x.id),
		),
		viewports: pick("WARREN_UI_VISUAL_VIEWPORTS", VIEWPORT_NAMES),
		themes: pick("WARREN_UI_VISUAL_THEMES", THEMES),
	};
}

/**
 * Screen routes declared in `app.tsx` source: every `<Route path=…>`
 * except redirects (`<Navigate>`), the catch-all, and layout routes in
 * `LAYOUT_ROUTES`. Relative child paths join the last absolute path.
 * The manifest test holds `PAGES` to this list so a new route without a
 * manifest entry fails `bun test`.
 */
export function screenRoutesFromAppSource(source: string): string[] {
	const routes: string[] = [];
	let parent = "";
	// `element={` may open with JSX comments before the element tag.
	const re = /<Route\s+path="([^"]+)"\s+element=\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*<(\w+)/g;
	for (const match of source.matchAll(re)) {
		const [, rawPath = "", element = ""] = match;
		const path = rawPath.startsWith("/") ? rawPath : `${parent}/${rawPath}`;
		if (rawPath.startsWith("/")) parent = rawPath;
		if (element === "Navigate" || rawPath === "*" || LAYOUT_ROUTES.includes(path)) continue;
		routes.push(path);
	}
	return routes;
}

/** Routes that only wrap child routes (their index redirects to a child). */
export const LAYOUT_ROUTES: readonly string[] = ["/telemetry"];
