import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CLIENT_PATH,
	contractViolations,
	isQuerySuffix,
	ROUTE_TABLE_PATH,
	resolvePath,
	routeMatches,
	scan,
	scanClient,
} from "./check-client-contract.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * These fixtures are TypeScript source under test, so they carry template
 * placeholders on purpose. Assembling them keeps a literal placeholder out of
 * a plain string, which is what biome's `noTemplateCurlyInString` flags.
 */
function interp(expr: string): string {
	return `\${${expr}}`;
}

/** The parts joined inside backticks, as template-literal source text. */
function tpl(...parts: string[]): string {
	return `\`${parts.join("")}\``;
}

/** A route table the extractor in generate-docs.ts can parse. */
function routeTableSource(entries: string[]): string {
	return [
		"const ROUTE_TABLE: readonly RouteEntry[] = [",
		...entries.map((e) => `\t${e}`),
		"];",
		"",
	].join("\n");
}

function routeEntry(method: string, pattern: string): string {
	return `{ method: "${method}", pattern: "${pattern}", policy: "readPublic", build: h },`;
}

/** Write a fake checkout holding just the two files the gate reads. */
function withFixtureRepo(client: string, routes: string[], run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-client-contract-"));
	try {
		for (const [relative, text] of [
			[CLIENT_PATH, client],
			[ROUTE_TABLE_PATH, routeTableSource(routes)],
		] as const) {
			const abs = join(dir, relative);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("resolvePath", () => {
	test("passes a quoted literal through", () => {
		expect(resolvePath('"/projects"', "")).toEqual({ kind: "resolved", path: "/projects" });
	});

	test("turns an encodeURIComponent segment into :param", () => {
		const arg = tpl("/runs/", interp("encodeURIComponent(id)"), "/cancel");
		expect(resolvePath(arg, "")).toEqual({ kind: "resolved", path: "/runs/:param/cancel" });
	});

	test("drops an inline query suffix and the static query it carries", () => {
		const suffix = interp(`qs.length > 0 ? \`?${interp("qs")}\` : ""`);
		expect(resolvePath(tpl("/runs", suffix), "")).toEqual({ kind: "resolved", path: "/runs" });
		expect(resolvePath('"/runs?limit=5"', "")).toEqual({ kind: "resolved", path: "/runs" });
	});

	test("drops a query suffix built by a local helper", () => {
		const source = [
			"function agentsQuery(filter: AgentsFilter): string {",
			'\tif (filter.projectId === undefined) return "";',
			`\treturn \`?${interp("params.toString()")}\`;`,
			"}",
		].join("\n");
		const arg = tpl("/agents", interp("agentsQuery(filter)"));
		expect(resolvePath(arg, source)).toEqual({ kind: "resolved", path: "/agents" });
	});

	test("refuses a path it cannot read instead of skipping it", () => {
		const arg = tpl("/runs/", interp("id"));
		expect(resolvePath(arg, "")).toEqual({ kind: "unresolvable", expr: "id" });
		expect(resolvePath("buildPath(id)", "")).toEqual({
			kind: "unresolvable",
			expr: "buildPath(id)",
		});
	});

	test("refuses an interpolation that is not the last part of the template", () => {
		const arg = tpl("/runs", interp("suffix()"), "/cancel");
		expect(resolvePath(arg, "")).toEqual({ kind: "unresolvable", expr: "suffix()" });
	});
});

describe("isQuerySuffix", () => {
	test("rejects a helper that can return a path segment", () => {
		const source = [
			"function scopeSegment(scope: string): string {",
			'\tif (scope === "") return "";',
			`\treturn \`/${interp("scope")}\`;`,
			"}",
		].join("\n");
		expect(isQuerySuffix("scopeSegment(scope)", source)).toBe(false);
	});

	test("rejects a call to a function this module cannot see", () => {
		expect(isQuerySuffix("elsewhereQuery(filter)", "")).toBe(false);
	});
});

describe("routeMatches", () => {
	test("matches a dynamic segment against a route parameter", () => {
		expect(routeMatches("/runs/:param/cancel", "/runs/:id/cancel")).toBe(true);
	});

	test("separates paths by segment count and by literal segments", () => {
		expect(routeMatches("/runs/:param", "/runs/:id/cancel")).toBe(false);
		expect(routeMatches("/plots", "/runs")).toBe(false);
	});
});

describe("scanClient", () => {
	test("reads the method off the options object and defaults to GET", () => {
		const source = [
			'const list = () => request<Rows>("/runs");',
			'const create = () => request<Row>("/runs", { method: "POST", body: input });',
		].join("\n");
		expect(scanClient(source).calls).toEqual([
			{ method: "GET", path: "/runs", line: 1 },
			{ method: "POST", path: "/runs", line: 2 },
		]);
	});

	test("reads the NDJSON streamer and skips the function declarations", () => {
		const source = [
			"async function request<T>(path: string): Promise<T> {",
			"\treturn fetch(path) as T;",
			"}",
			"async function* streamNdjsonEvents(basePath: string) {",
			"\tyield basePath;",
			"}",
			`const events = () => streamNdjsonEvents(${tpl("/runs/", interp("encodeURIComponent(id)"), "/events")}, opts);`,
		].join("\n");
		expect(scanClient(source).calls).toEqual([
			{ method: "GET", path: "/runs/:param/events", line: 7 },
		]);
	});

	test("reports an unreadable path with its line", () => {
		const scanned = scanClient(`const get = () => request<Row>(${tpl("/runs/", interp("id"))});`);
		expect(scanned.calls).toEqual([]);
		expect(scanned.unresolvable).toEqual([
			{
				line: 1,
				reason: "unresolvable_path",
				detail: `request path is not statically resolvable: ${interp("id")}`,
			},
		]);
	});
});

describe("contractViolations", () => {
	test("accepts a call the route table serves", () => {
		const scanned = scanClient('const list = () => request<Rows>("/runs");');
		expect(contractViolations(scanned, [{ method: "GET", pattern: "/runs" }])).toEqual([]);
	});

	test("fails a call to a route nobody serves", () => {
		const scanned = scanClient('const list = () => request<Rows>("/plots");');
		expect(contractViolations(scanned, [{ method: "GET", pattern: "/runs" }])).toEqual([
			{
				line: 1,
				reason: "no_matching_route",
				detail: `GET /plots is not in ${ROUTE_TABLE_PATH}`,
			},
		]);
	});

	test("fails a method the route table does not serve on that path", () => {
		const scanned = scanClient('const del = () => request<Row>("/runs", { method: "DELETE" });');
		expect(contractViolations(scanned, [{ method: "GET", pattern: "/runs" }])).toEqual([
			{
				line: 1,
				reason: "no_matching_route",
				detail: `DELETE /runs is not in ${ROUTE_TABLE_PATH}`,
			},
		]);
	});
});

describe("scan", () => {
	test("reads both files out of a checkout and agrees", () => {
		withFixtureRepo(
			[
				'const list = () => request<Rows>("/runs");',
				`const get = () => request<Row>(${tpl("/runs/", interp("encodeURIComponent(id)"))});`,
			].join("\n"),
			[routeEntry("GET", "/runs"), routeEntry("GET", "/runs/:id"), routeEntry("GET", "/healthz")],
			(dir) => {
				const result = scan(dir);
				expect(result.violations).toEqual([]);
				expect(result.calls.length).toBe(2);
				expect(result.unused).toEqual([{ method: "GET", pattern: "/healthz" }]);
			},
		);
	});

	test("surfaces a retired route the UI still calls (the warren-1f12 shape)", () => {
		withFixtureRepo(
			`const get = () => request<Row>(${tpl("/plots/", interp("encodeURIComponent(id)"), "/summary")});`,
			[routeEntry("GET", "/runs")],
			(dir) => {
				expect(scan(dir).violations).toEqual([
					{
						line: 1,
						reason: "no_matching_route",
						detail: `GET /plots/:param/summary is not in ${ROUTE_TABLE_PATH}`,
					},
				]);
			},
		);
	});

	test("passes on the real checkout", () => {
		expect(scan(REPO_ROOT).violations).toEqual([]);
	});
});
