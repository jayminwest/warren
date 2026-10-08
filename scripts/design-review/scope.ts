/**
 * Which pages a PR's diff plausibly changes (warren-a694, plan pl-10db step 15).
 *
 * The design-review workflow shows the evaluator only the screenshots of the
 * pages in scope, which bounds its cost. A file under one page's source maps
 * to that page. A file nothing renders (a test, a Markdown note) maps to no
 * page. Anything else under `src/ui/` (components, the console shell, hooks,
 * the API client, tokens, the build config) can change every page, so it
 * widens the scope to all of them: when unsure, review everything.
 *
 * Pure: it imports only the page manifest, so `bun test` loads it directly.
 */

import { PAGES } from "../ui-visual/pages.ts";

/** A PR "touches the UI" when it changes a file under this prefix. */
export const UI_PREFIX = "src/ui/";
const PAGES_DIR = `${UI_PREFIX}src/pages/`;

/**
 * Page source stems under `src/ui/src/pages/`, most specific first. A stem
 * matches `<stem>.tsx`, `<stem>/…`, `<stem>.<part>.tsx`, and `<stem>-<part>.ts`
 * (for example `project-detail-layout.ts`), so `dispatch-plan` must come
 * before `dispatch`.
 */
export const PAGE_SOURCES: readonly (readonly [stem: string, pages: readonly string[]])[] = [
	["telemetry/loop-tab", ["telemetry-loop"]],
	["telemetry/behavior-tab", ["telemetry-behavior"]],
	["telemetry/judge", ["telemetry-judge"]],
	["telemetry/economics", ["telemetry-economics"]],
	["telemetry", ["telemetry-loop", "telemetry-behavior", "telemetry-judge", "telemetry-economics"]],
	["dispatch-plan", ["dispatch-plan"]],
	["dispatch", ["dispatch"]],
	["plan-run-detail", ["plan-run-detail"]],
	["plan-runs", ["plan-runs"]],
	["run-detail", ["run-detail"]],
	["runs", ["runs"]],
	["project-detail", ["project-detail"]],
	["projects", ["projects"]],
	["operations", ["operations"]],
	["agents", ["agents"]],
	["event-explorer", ["events"]],
	["instance", ["instance"]],
	["setup", ["setup"]],
	["login", ["login"]],
];

/** Files that never change what renders: tests and prose. */
export function isInert(path: string): boolean {
	return /\.test\.tsx?$/.test(path) || /\.md$/i.test(path);
}

export function touchesUi(files: readonly string[]): boolean {
	return files.some((f) => f.startsWith(UI_PREFIX));
}

/** The changed files that can change what renders. */
export function renderedUiFiles(files: readonly string[]): string[] {
	return files.filter((f) => f.startsWith(UI_PREFIX) && !isInert(f));
}

/** The pages one rendered UI file maps to; null means "unsure: every page". */
export function pagesForFile(path: string): readonly string[] | null {
	if (!path.startsWith(PAGES_DIR)) return null;
	const rel = path.slice(PAGES_DIR.length);
	for (const [stem, pages] of PAGE_SOURCES) {
		if (rel === stem || (rel.startsWith(stem) && /^[./-]/.test(rel.slice(stem.length)))) {
			return pages;
		}
	}
	return null;
}

export interface Scope {
	/** Page ids in manifest order. Empty when nothing rendered changed. */
	readonly pages: readonly string[];
	/** True when a file widened the scope to every page. */
	readonly allPages: boolean;
	/** The rendered UI files that drove the scope. */
	readonly files: readonly string[];
}

/** Map a PR's changed files to the manifest pages in scope. */
export function scopeForFiles(files: readonly string[]): Scope {
	const rendered = renderedUiFiles(files);
	const ids = new Set<string>();
	let allPages = false;
	for (const file of rendered) {
		const pages = pagesForFile(file);
		if (pages === null) allPages = true;
		else for (const p of pages) ids.add(p);
	}
	const pages = PAGES.map((p) => p.id).filter((id) => allPages || ids.has(id));
	return { pages, allPages, files: rendered };
}

/** Every page: the fallback when the file list cannot be trusted to be whole. */
export function allPagesScope(files: readonly string[]): Scope {
	return { pages: PAGES.map((p) => p.id), allPages: true, files };
}
