import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { buildDocument, convertPattern, generate, tagFor } from "./generate-openapi.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("generate-openapi", () => {
	test("docs/openapi.yaml is in sync with src/server/handlers/index.ts", () => {
		const { content } = generate();
		const onDisk = readFileSync(resolve(REPO_ROOT, "docs/openapi.yaml"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("generated document parses as YAML and looks like OpenAPI 3.1", () => {
		const { content, routeCount } = generate();
		const parsed = load(content) as Record<string, unknown>;
		expect(parsed.openapi).toBe("3.1.0");
		expect(parsed.info).toBeDefined();
		const paths = parsed.paths as Record<string, unknown>;
		expect(Object.keys(paths).length).toBeGreaterThan(0);
		// Path count <= route count (some paths share method-collapsed entries).
		expect(Object.keys(paths).length).toBeLessThanOrEqual(routeCount);
	});

	test("convertPattern rewrites :param to {param} and emits a path parameter", () => {
		const { openapiPath, parameters } = convertPattern("/runs/:id/preview/login");
		expect(openapiPath).toBe("/runs/{id}/preview/login");
		expect(parameters).toEqual([
			{ name: "id", in: "path", required: true, schema: { type: "string" } },
		]);
	});

	test("convertPattern dedupes repeated params and handles multi-param paths", () => {
		const { openapiPath, parameters } = convertPattern("/projects/:id/seeds/:seedId/things/:id");
		expect(openapiPath).toBe("/projects/{id}/seeds/{seedId}/things/{id}");
		expect(parameters.map((p) => p.name)).toEqual(["id", "seedId"]);
	});

	test("convertPattern leaves static paths untouched", () => {
		const { openapiPath, parameters } = convertPattern("/healthz");
		expect(openapiPath).toBe("/healthz");
		expect(parameters).toEqual([]);
	});

	test("tagFor groups meta endpoints and uses first segment elsewhere", () => {
		expect(tagFor("/healthz")).toBe("meta");
		expect(tagFor("/readyz")).toBe("meta");
		expect(tagFor("/version")).toBe("meta");
		expect(tagFor("/runs/:id")).toBe("runs");
		expect(tagFor("/plots/:id/summary")).toBe("plots");
	});

	test("buildDocument collapses methods on the same path into one path item", () => {
		const doc = buildDocument(
			[
				{ method: "GET", pattern: "/runs", handler: "listRunsHandler" },
				{ method: "POST", pattern: "/runs", handler: "createRunHandler" },
			],
			"9.9.9",
		);
		expect(doc.info.version).toBe("9.9.9");
		const item = doc.paths["/runs"];
		expect(item?.get?.operationId).toBe("listRunsHandler");
		expect(item?.post?.operationId).toBe("createRunHandler");
	});

	test("buildDocument carries route comments into the operation description", () => {
		const doc = buildDocument(
			[
				{
					method: "GET",
					pattern: "/plots/needs-attention/count",
					handler: "needsAttentionCountHandler",
					comment: "Static path — must precede `/plots/:id`.",
				},
			],
			"0.0.0",
		);
		const op = doc.paths["/plots/needs-attention/count"]?.get;
		expect(op?.description).toContain("must precede");
	});

	test("buildDocument emits both 200 and default responses for every operation", () => {
		const doc = buildDocument(
			[{ method: "GET", pattern: "/healthz", handler: "healthz" }],
			"0.0.0",
		);
		const op = doc.paths["/healthz"]?.get;
		expect(op?.responses["200"]).toBeDefined();
		expect(op?.responses.default).toBeDefined();
	});
});
