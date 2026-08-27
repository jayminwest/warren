#!/usr/bin/env bun
/**
 * Automated OpenAPI 3.1 schema generator for warren's HTTP API
 * (warren-b46b, plan pl-7b06 step 21).
 *
 * Like `generate-docs.ts`, this derives its output directly from the
 * `ROUTE_TABLE` constant in `src/server/handlers/route-table.ts` so the published
 * schema can't drift from the running router. Where `generate-docs.ts`
 * produces a human-readable Markdown route table, this script emits a
 * machine-readable OpenAPI 3.1 document (`docs/openapi.yaml`) suitable
 * for client codegen, spec linting, and contract tooling.
 *
 * Scope (intentional V1 floor):
 * - Paths, methods, path parameters, and operationIds derived from the
 *   handler symbol name are covered. The route ordering caveats encoded
 *   as `//` comments in `ROUTE_TABLE` (e.g. "must precede `/plots/:id`")
 *   are surfaced as the operation's `description`.
 * - `components.schemas` covers the core document shapes (run, plan-run,
 *   project, agent, error envelope) with every enum-typed field derived
 *   from the canonical constants in `src/core/wire.ts` (warren-5334) —
 *   the spec cannot drift from the wire vocabulary. Routes whose
 *   response envelope the generator knows carry a `$ref` body schema;
 *   the rest stay permissive `application/json` objects.
 * - Request body schemas are NOT introspected from the handler
 *   implementations — they remain out of scope.
 *
 * Modes:
 *   bun run gen:openapi          # write docs/openapi.yaml
 *   bun run gen:openapi:check    # exit 1 if docs/openapi.yaml is stale
 *
 * The check mode is wired into `bun run check:all`; CI fails when the
 * route table changes but the schema isn't regenerated. Fix by running
 * `bun run gen:openapi` and committing the result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dump } from "js-yaml";
import {
	AGENT_SOURCES,
	CLONE_KINDS,
	EVENT_STREAMS,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_SOURCES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	PULL_REQUEST_LIFECYCLES,
	RUN_COST_BASES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
} from "../src/core/wire.ts";
import { extractRoutes, type Route } from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HANDLERS_PATH = resolve(REPO_ROOT, "src/server/handlers/route-table.ts");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/openapi.yaml");

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

type OpenApiParameter = {
	name: string;
	in: "path";
	required: true;
	schema: { type: "string" };
};

type JsonSchema = Record<string, unknown>;

type OpenApiResponse = {
	description: string;
	content?: { "application/json": { schema: JsonSchema } };
};

type OpenApiOperation = {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	parameters?: OpenApiParameter[];
	responses: Record<string, OpenApiResponse>;
};

type OpenApiPathItem = Partial<Record<Lowercase<Route["method"]>, OpenApiOperation>>;

type OpenApiDocument = {
	openapi: "3.1.0";
	info: { title: string; version: string; description: string };
	tags: { name: string; description: string }[];
	paths: Record<string, OpenApiPathItem>;
	components: { schemas: Record<string, JsonSchema> };
};

/* ------------------------------------------------------------------ */
/* Component schemas (warren-5334). Every enum is DERIVED from the     */
/* canonical constants in `src/core/wire.ts` — never hand-spelled, so  */
/* the published spec cannot drift from the wire vocabulary. Document  */
/* shapes mirror the SDK row types (`src/client/types*.ts`).           */
/* ------------------------------------------------------------------ */

/** String enum schema derived from a wire.ts `as const` tuple. */
function enumSchema(values: readonly string[]): JsonSchema {
	return { type: "string", enum: [...values] };
}

/** Nullable variant: the enum value or JSON null. */
function nullableEnumSchema(values: readonly string[]): JsonSchema {
	return { type: ["string", "null"], enum: [...values, null] };
}

function refSchema(name: string): JsonSchema {
	return { $ref: `#/components/schemas/${name}` };
}

function arrayOf(item: JsonSchema): JsonSchema {
	return { type: "array", items: item };
}

const STRING = { type: "string" } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"] } as const;

/** Required-everywhere object envelope: `{ <key>: <schema>, ... }`. */
function envelope(properties: Record<string, JsonSchema>): JsonSchema {
	return { type: "object", properties, required: Object.keys(properties) };
}

function buildComponentSchemas(): Record<string, JsonSchema> {
	return {
		RunState: enumSchema(RUN_STATES),
		RunFailureReason: enumSchema(RUN_FAILURE_REASONS),
		RunMode: enumSchema(RUN_MODES),
		RunCostBasis: enumSchema(RUN_COST_BASES),
		CloneKind: enumSchema(CLONE_KINDS),
		PreviewState: enumSchema(PREVIEW_STATES),
		EventStream: enumSchema(EVENT_STREAMS),
		PlanRunState: enumSchema(PLAN_RUN_STATES),
		PlanRunChildState: enumSchema(PLAN_RUN_CHILD_STATES),
		AgentSource: enumSchema(AGENT_SOURCES),
		PullRequestLifecycle: enumSchema(PULL_REQUEST_LIFECYCLES),
		ErrorEnvelope: envelope({
			error: {
				type: "object",
				properties: { code: STRING, message: STRING, hint: STRING },
				required: ["code", "message"],
			},
		}),
		Project: {
			type: "object",
			properties: {
				id: STRING,
				gitUrl: STRING,
				localPath: STRING,
				defaultBranch: STRING,
				addedAt: STRING,
				lastFetchedAt: NULLABLE_STRING,
				lastHeadSha: NULLABLE_STRING,
				hasSeeds: { type: "boolean" },
			},
			required: [
				"id",
				"gitUrl",
				"localPath",
				"defaultBranch",
				"addedAt",
				"lastFetchedAt",
				"lastHeadSha",
				"hasSeeds",
			],
		},
		Agent: {
			type: "object",
			properties: {
				name: STRING,
				renderedJson: {},
				registeredAt: STRING,
				lastRefreshed: STRING,
				description: NULLABLE_STRING,
				provider: NULLABLE_STRING,
				model: NULLABLE_STRING,
				source: refSchema("AgentSource"),
			},
			required: ["name", "registeredAt", "lastRefreshed", "description", "provider", "model"],
		},
		Run: {
			type: "object",
			properties: {
				id: STRING,
				agentName: STRING,
				projectId: NULLABLE_STRING,
				sandboxId: NULLABLE_STRING,
				sandboxRunId: NULLABLE_STRING,
				seedId: NULLABLE_STRING,
				parentRunId: NULLABLE_STRING,
				cloneKind: nullableEnumSchema(CLONE_KINDS),
				mode: refSchema("RunMode"),
				provider: NULLABLE_STRING,
				model: NULLABLE_STRING,
				renderedAgentJson: {},
				state: refSchema("RunState"),
				failureReason: nullableEnumSchema(RUN_FAILURE_REASONS),
				createdAt: NULLABLE_NUMBER,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
				commitsAhead: NULLABLE_INTEGER,
				filesChanged: NULLABLE_INTEGER,
				insertions: NULLABLE_INTEGER,
				deletions: NULLABLE_INTEGER,
				prompt: STRING,
				trigger: STRING,
				prUrl: NULLABLE_STRING,
				prState: nullableEnumSchema(PULL_REQUEST_LIFECYCLES),
				prMergedAt: NULLABLE_STRING,
				targetBranch: NULLABLE_STRING,
				ref: NULLABLE_STRING,
				salvageRef: NULLABLE_STRING,
				salvagePath: NULLABLE_STRING,
				costUsd: NULLABLE_NUMBER,
				tokensInput: NULLABLE_INTEGER,
				tokensOutput: NULLABLE_INTEGER,
				tokensCacheRead: NULLABLE_INTEGER,
				tokensCacheWrite: NULLABLE_INTEGER,
				previewState: nullableEnumSchema(PREVIEW_STATES),
				previewPort: NULLABLE_INTEGER,
				previewStartedAt: NULLABLE_STRING,
				previewLastHitAt: NULLABLE_STRING,
				previewFailureMessage: NULLABLE_STRING,
				costBasis: refSchema("RunCostBasis"),
			},
			required: ["id", "agentName", "mode", "state", "prompt", "trigger", "costBasis"],
		},
		PlanRun: {
			type: "object",
			properties: {
				id: STRING,
				planId: NULLABLE_STRING,
				source: enumSchema(PLAN_RUN_SOURCES),
				projectId: STRING,
				agentName: STRING,
				promptTemplate: STRING,
				ref: NULLABLE_STRING,
				providerOverride: NULLABLE_STRING,
				modelOverride: NULLABLE_STRING,
				maxCostUsd: NULLABLE_NUMBER,
				dispatcherHandle: STRING,
				trigger: STRING,
				state: refSchema("PlanRunState"),
				failureReason: NULLABLE_STRING,
				createdAt: STRING,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
			},
			required: [
				"id",
				"source",
				"projectId",
				"agentName",
				"promptTemplate",
				"dispatcherHandle",
				"trigger",
				"state",
				"createdAt",
			],
		},
		PlanRunChild: {
			type: "object",
			properties: {
				planRunId: STRING,
				seq: { type: "integer" },
				seedId: STRING,
				runId: NULLABLE_STRING,
				state: refSchema("PlanRunChildState"),
				createdAt: STRING,
				updatedAt: STRING,
				startedAt: NULLABLE_STRING,
				endedAt: NULLABLE_STRING,
				prMergedAt: NULLABLE_STRING,
				failureReason: NULLABLE_STRING,
			},
			required: ["planRunId", "seq", "seedId", "runId", "state", "createdAt", "updatedAt"],
		},
	};
}

/**
 * Routes whose 200-response envelope the generator knows, keyed by
 * `METHOD pattern`. Anything not listed keeps the permissive bare
 * description (request bodies stay out of scope entirely).
 */
const KNOWN_RESPONSE_BODIES: Record<string, JsonSchema> = {
	"GET /runs": envelope({
		runs: arrayOf(refSchema("Run")),
		total: { type: "integer" },
		limit: { type: "integer" },
		offset: { type: "integer" },
		costTotalUsd: NULLABLE_NUMBER,
		costPricedCount: { type: "integer" },
	}),
	"POST /runs": envelope({
		run: refSchema("Run"),
		sandbox: envelope({ id: STRING, workspacePath: STRING }),
	}),
	"GET /runs/:id": envelope({ run: refSchema("Run") }),
	"GET /projects": envelope({ projects: arrayOf(refSchema("Project")) }),
	"POST /projects": envelope({ project: refSchema("Project") }),
	"GET /projects/:id": envelope({ project: refSchema("Project") }),
	"GET /agents": envelope({ agents: arrayOf(refSchema("Agent")) }),
	"GET /plan-runs": envelope({ planRuns: arrayOf(refSchema("PlanRun")) }),
	"POST /plan-runs": envelope({
		planRun: refSchema("PlanRun"),
		children: arrayOf(refSchema("PlanRunChild")),
	}),
	"GET /plan-runs/:id": envelope({
		planRun: refSchema("PlanRun"),
		children: arrayOf(refSchema("PlanRunChild")),
		runs: arrayOf(refSchema("Run")),
	}),
	"POST /plan-runs/:id/cancel": envelope({
		planRun: refSchema("PlanRun"),
		cancelledChild: {
			type: ["object", "null"],
			properties: { childSeq: { type: "integer" }, runId: STRING },
		},
		alreadyTerminal: { type: "boolean" },
	}),
};

function jsonContent(schema: JsonSchema): OpenApiResponse["content"] {
	return { "application/json": { schema } };
}

/**
 * Convert a warren route pattern like `/runs/:id/preview/login` into
 * the OpenAPI-canonical `/runs/{id}/preview/login` form plus the list
 * of declared path parameters.
 */
export function convertPattern(pattern: string): {
	openapiPath: string;
	parameters: OpenApiParameter[];
} {
	const parameters: OpenApiParameter[] = [];
	const seen = new Set<string>();
	const openapiPath = pattern.replace(PATH_PARAM_RE, (_, name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			parameters.push({
				name,
				in: "path",
				required: true,
				schema: { type: "string" },
			});
		}
		return `{${name}}`;
	});
	return { openapiPath, parameters };
}

/**
 * First path segment is used as both the OpenAPI tag and (with the
 * handler name) the operation's summary. Root-level routes (`/healthz`,
 * `/version`, …) collapse under a shared `meta` tag.
 */
export function tagFor(pattern: string): string {
	const segment = pattern.split("/")[1] ?? "";
	if (!segment) return "meta";
	if (segment.startsWith(":")) return "meta";
	if (segment === "healthz" || segment === "readyz" || segment === "version") {
		return "meta";
	}
	return segment;
}

function buildOperation(route: Route, parameters: OpenApiParameter[]): OpenApiOperation {
	const body = KNOWN_RESPONSE_BODIES[`${route.method} ${route.pattern}`];
	const ok: OpenApiResponse = { description: "Successful response." };
	if (body) ok.content = jsonContent(body);
	const op: OpenApiOperation = {
		operationId: route.handler,
		tags: [tagFor(route.pattern)],
		summary: `${route.method} ${route.pattern}`,
		responses: {
			"200": ok,
			default: {
				description: "Error response (see `src/core/errors.ts`).",
				content: jsonContent(refSchema("ErrorEnvelope")),
			},
		},
	};
	if (route.comment) op.description = route.comment;
	if (parameters.length > 0) op.parameters = parameters;
	return op;
}

export function buildDocument(routes: readonly Route[], version: string): OpenApiDocument {
	const paths: Record<string, OpenApiPathItem> = {};
	const tagSet = new Set<string>();

	for (const route of routes) {
		const { openapiPath, parameters } = convertPattern(route.pattern);
		const item: OpenApiPathItem = paths[openapiPath] ?? {};
		const method = route.method.toLowerCase() as Lowercase<Route["method"]>;
		item[method] = buildOperation(route, parameters);
		paths[openapiPath] = item;
		tagSet.add(tagFor(route.pattern));
	}

	const tags = [...tagSet].sort().map((name) => ({
		name,
		description: name === "meta" ? "Liveness, readiness, and version." : `\`/${name}\` routes.`,
	}));

	// Sort paths alphabetically for stable output.
	const sortedPaths: Record<string, OpenApiPathItem> = {};
	for (const key of Object.keys(paths).sort()) {
		const value = paths[key];
		if (value !== undefined) sortedPaths[key] = value;
	}

	return {
		openapi: "3.1.0",
		info: {
			title: "warren HTTP API",
			version,
			description:
				"Auto-generated from `src/server/handlers/route-table.ts`'s `ROUTE_TABLE`. " +
				"Run `bun run gen:openapi` to refresh; CI fails if this schema " +
				"drifts from the handler module. Response schemas for the core " +
				"documents live under `components.schemas`, with enum vocabulary " +
				"derived from `src/core/wire.ts`; request bodies and routes without " +
				"a known envelope stay permissive — see docs/http-api.md for the " +
				"canonical handler contracts.",
		},
		tags,
		paths: sortedPaths,
		components: { schemas: buildComponentSchemas() },
	};
}

function readPackageVersion(): string {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: unknown };
	if (typeof pkg.version !== "string" || pkg.version.length === 0) {
		throw new Error("package.json is missing a string `version` field.");
	}
	return pkg.version;
}

export function generate(): { content: string; routeCount: number } {
	const source = readFileSync(HANDLERS_PATH, "utf8");
	const routes = extractRoutes(source);
	if (routes.length === 0) {
		throw new Error("Extractor found zero routes — refusing to overwrite docs/openapi.yaml.");
	}
	const doc = buildDocument(routes, readPackageVersion());
	const body = dump(doc, { lineWidth: 100, noRefs: true, sortKeys: false });
	const header = [
		"# AUTO-GENERATED by `bun run gen:openapi` from `src/server/handlers/route-table.ts`.",
		"# Do not edit by hand. CI fails if this file is out of sync.",
		"",
	].join("\n");
	return { content: `${header}${body}`, routeCount: routes.length };
}

function readExisting(): string | null {
	try {
		return readFileSync(OUTPUT_PATH, "utf8");
	} catch {
		return null;
	}
}

function main(): void {
	const checkMode = process.argv.includes("--check");
	const { content, routeCount } = generate();
	const existing = readExisting();

	if (checkMode) {
		if (existing === null) {
			console.error(
				"docs/openapi.yaml is missing. Run `bun run gen:openapi` and commit the result.",
			);
			process.exit(1);
		}
		if (existing !== content) {
			console.error("docs/openapi.yaml is stale relative to src/server/handlers/route-table.ts.");
			console.error("Run `bun run gen:openapi` and commit the result.");
			process.exit(1);
		}
		console.log(`gen:openapi ok (${routeCount} routes).`);
		return;
	}

	writeFileSync(OUTPUT_PATH, content);
	console.log(`Wrote docs/openapi.yaml (${routeCount} routes).`);
}

if (import.meta.main) main();
