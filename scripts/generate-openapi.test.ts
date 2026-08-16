import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import {
	AGENT_SOURCES,
	EVENT_STREAMS,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	PULL_REQUEST_LIFECYCLES,
	RUN_FAILURE_REASONS,
	RUN_STATES,
} from "../src/core/wire.ts";
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

	test("components.schemas derives enum vocabulary from src/core/wire.ts", () => {
		const doc = buildDocument([], "0.0.0");
		const schemas = doc.components.schemas as Record<string, { type?: unknown; enum?: unknown[] }>;
		expect(schemas.RunState?.enum).toEqual([...RUN_STATES]);
		expect(schemas.RunFailureReason?.enum).toEqual([...RUN_FAILURE_REASONS]);
		expect(schemas.PlanRunState?.enum).toEqual([...PLAN_RUN_STATES]);
		expect(schemas.PlanRunChildState?.enum).toEqual([...PLAN_RUN_CHILD_STATES]);
		expect(schemas.PreviewState?.enum).toEqual([...PREVIEW_STATES]);
		expect(schemas.EventStream?.enum).toEqual([...EVENT_STREAMS]);
		expect(schemas.AgentSource?.enum).toEqual([...AGENT_SOURCES]);
		expect(schemas.PullRequestLifecycle?.enum).toEqual([...PULL_REQUEST_LIFECYCLES]);
	});

	test("components.schemas covers the core document shapes", () => {
		const doc = buildDocument([], "0.0.0");
		for (const name of ["Run", "PlanRun", "PlanRunChild", "Project", "Agent", "ErrorEnvelope"]) {
			expect(doc.components.schemas[name]).toBeDefined();
		}
		// The run document carries the dispatch-time ref (warren-afeb / PR #916).
		const run = doc.components.schemas.Run as { properties: Record<string, unknown> };
		expect(run.properties.ref).toBeDefined();
		expect(run.properties.state).toEqual({ $ref: "#/components/schemas/RunState" });
	});

	test("default error response references the ErrorEnvelope schema", () => {
		const doc = buildDocument(
			[{ method: "GET", pattern: "/healthz", handler: "healthz" }],
			"0.0.0",
		);
		const op = doc.paths["/healthz"]?.get;
		expect(op?.responses.default?.content?.["application/json"]?.schema).toEqual({
			$ref: "#/components/schemas/ErrorEnvelope",
		});
	});

	test("known routes wire their 200 response to a component schema", () => {
		const doc = buildDocument(
			[
				{ method: "GET", pattern: "/runs/:id", handler: "getRunHandler" },
				{ method: "GET", pattern: "/agents", handler: "listAgentsHandler" },
			],
			"0.0.0",
		);
		const runBody = doc.paths["/runs/{id}"]?.get?.responses["200"]?.content?.["application/json"]
			?.schema as { properties: Record<string, unknown> };
		expect(runBody.properties.run).toEqual({ $ref: "#/components/schemas/Run" });
		const agentsBody = doc.paths["/agents"]?.get?.responses["200"]?.content?.["application/json"]
			?.schema as { properties: { agents: { items: unknown } } };
		expect(agentsBody.properties.agents.items).toEqual({
			$ref: "#/components/schemas/Agent",
		});
	});

	test("unknown routes keep a permissive 200 with no body schema", () => {
		const doc = buildDocument(
			[{ method: "POST", pattern: "/runs/:id/steer", handler: "steerRunHandler" }],
			"0.0.0",
		);
		const ok = doc.paths["/runs/{id}/steer"]?.post?.responses["200"];
		expect(ok?.description).toBe("Successful response.");
		expect(ok?.content).toBeUndefined();
	});
});
