import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_AGENTS } from "../src/registry/builtins/index.ts";
import {
	extractRoutes,
	generate,
	generateBuiltinAgentsManifest,
	groupRoutes,
	renderMarkdown,
} from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("generate-docs", () => {
	test("docs/http-api.md is in sync with src/server/handlers/route-table.ts", () => {
		const { content } = generate();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/http-api.md"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("extracts a healthy number of routes from the real handlers module", () => {
		const { routes } = generate();
		expect(routes.length).toBeGreaterThanOrEqual(35);
		// Sanity-check a few canonical ones.
		const patterns = new Set(routes.map((r) => `${r.method} ${r.pattern}`));
		expect(patterns.has("GET /healthz")).toBe(true);
		expect(patterns.has("GET /readyz")).toBe(true);
		expect(patterns.has("GET /version")).toBe(true);
		expect(patterns.has("POST /runs")).toBe(true);
	});

	test("preserves ordering caveats from leading // comments", () => {
		const { routes } = generate();
		// Static path — must precede `/projects/:id/seeds/:seedId`.
		const seedsPlans = routes.find((r) => r.pattern === "/projects/:id/seeds/plans");
		expect(seedsPlans?.comment).toBeDefined();
		expect(seedsPlans?.comment ?? "").toContain("must precede");
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

describe("generate-docs builtin-agents manifest", () => {
	test("docs/builtin-agents.json is in sync with BUILTIN_AGENTS", () => {
		const { content } = generateBuiltinAgentsManifest();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/builtin-agents.json"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("manifest lists every builtin exactly once with a non-empty role", () => {
		const { manifest } = generateBuiltinAgentsManifest();
		expect(manifest.count).toBe(BUILTIN_AGENTS.length);
		expect(manifest.count).toBeGreaterThan(0);
		const names = manifest.agents.map((a) => a.name);
		expect(new Set(names).size).toBe(names.length);
		expect([...names].sort()).toEqual([...BUILTIN_AGENTS.map((a) => a.name)].sort());
		for (const agent of manifest.agents) {
			expect(agent.role.trim().length).toBeGreaterThan(0);
			expect(agent.role).not.toContain("\n");
		}
	});

	test("manifest is deterministic across runs", () => {
		expect(generateBuiltinAgentsManifest().content).toBe(generateBuiltinAgentsManifest().content);
	});

	test("manifest content is valid JSON with the stable top-level shape", () => {
		const { content } = generateBuiltinAgentsManifest();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(["source", "count", "agents"]);
		expect(parsed.count).toBe((parsed.agents as unknown[]).length);
		expect(content.endsWith("\n")).toBe(true);
	});
});
