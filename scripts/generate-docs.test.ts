import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractRoutes, generate, groupRoutes, renderMarkdown } from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("generate-docs", () => {
	test("docs/http-api.md is in sync with src/server/handlers/index.ts", () => {
		const { content } = generate();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/http-api.md"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("extracts a healthy number of routes from the real handlers module", () => {
		const { routes } = generate();
		expect(routes.length).toBeGreaterThanOrEqual(40);
		// Sanity-check a few canonical ones.
		const patterns = new Set(routes.map((r) => `${r.method} ${r.pattern}`));
		expect(patterns.has("GET /healthz")).toBe(true);
		expect(patterns.has("GET /readyz")).toBe(true);
		expect(patterns.has("GET /version")).toBe(true);
		expect(patterns.has("POST /runs")).toBe(true);
	});

	test("preserves ordering caveats from leading // comments", () => {
		const { routes } = generate();
		const needsAttention = routes.find((r) => r.pattern === "/plots/needs-attention/count");
		expect(needsAttention?.comment).toBeDefined();
		expect(needsAttention?.comment ?? "").toContain("must precede");
	});

	test("extractRoutes handles single-line and multi-line entries", () => {
		const src = [
			"const ROUTE_TABLE: readonly RouteEntry[] = [",
			'\t{ method: "GET", pattern: "/healthz", build: () => healthz() },',
			"\t{",
			'\t\tmethod: "POST",',
			'\t\tpattern: "/runs/:id/cancel",',
			"\t\tbuild: cancelRunHandler,",
			"\t},",
			"];",
		].join("\n");
		const routes = extractRoutes(src);
		expect(routes).toHaveLength(2);
		expect(routes[0]).toMatchObject({
			method: "GET",
			pattern: "/healthz",
			handler: "healthz",
		});
		expect(routes[1]).toMatchObject({
			method: "POST",
			pattern: "/runs/:id/cancel",
			handler: "cancelRunHandler",
		});
	});

	test("extractRoutes attaches preceding // comments to the next entry", () => {
		const src = [
			"const ROUTE_TABLE: readonly RouteEntry[] = [",
			"\t// Static path — must precede the param route below.",
			'\t{ method: "GET", pattern: "/plots/needs-attention/count", build: needsAttentionCountHandler },',
			'\t{ method: "GET", pattern: "/plots/:id", build: getPlotHandler },',
			"];",
		].join("\n");
		const routes = extractRoutes(src);
		expect(routes[0]?.comment).toBeDefined();
		expect(routes[0]?.comment ?? "").toContain("must precede");
		expect(routes[1]?.comment).toBeUndefined();
	});

	test("extractRoutes throws when ROUTE_TABLE is missing", () => {
		expect(() => extractRoutes("const SOMETHING_ELSE = [];")).toThrow(/ROUTE_TABLE/);
	});

	test("groupRoutes groups by first path segment", () => {
		const groups = groupRoutes([
			{ method: "GET", pattern: "/runs", handler: "a" },
			{ method: "POST", pattern: "/runs", handler: "b" },
			{ method: "GET", pattern: "/projects/:id", handler: "c" },
		]);
		expect(groups.get("runs")).toHaveLength(2);
		expect(groups.get("projects")).toHaveLength(1);
	});

	test("renderMarkdown produces an AUTO-GENERATED banner and route count", () => {
		const md = renderMarkdown([
			{ method: "GET", pattern: "/healthz", handler: "healthz" },
			{ method: "POST", pattern: "/runs", handler: "createRunHandler" },
		]);
		expect(md).toContain("AUTO-GENERATED");
		expect(md).toContain("Total routes: **2**.");
		expect(md).toContain("`/healthz`");
		expect(md).toContain("`createRunHandler`");
	});

	test("renderMarkdown escapes pipe characters inside comments", () => {
		const md = renderMarkdown([
			{
				method: "GET",
				pattern: "/x",
				handler: "x",
				comment: "matches a|b alternation",
			},
		]);
		expect(md).toContain("a\\|b");
	});
});
