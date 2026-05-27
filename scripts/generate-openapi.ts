#!/usr/bin/env bun
/**
 * Automated OpenAPI 3.1 schema generator for warren's HTTP API
 * (warren-b46b, plan pl-7b06 step 21).
 *
 * Like `generate-docs.ts`, this derives its output directly from the
 * `ROUTE_TABLE` constant in `src/server/handlers/index.ts` so the published
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
 * - Request/response body schemas are NOT introspected from the
 *   handler implementations — they remain `application/json` with a
 *   permissive object schema. Tightening this is tracked separately;
 *   we'd rather ship a sync-by-construction skeleton that lints clean
 *   in Spectral/Stoplight today than wait on a full handler-IO model.
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
import { extractRoutes, type Route } from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HANDLERS_PATH = resolve(REPO_ROOT, "src/server/handlers/index.ts");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/openapi.yaml");

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

type OpenApiParameter = {
	name: string;
	in: "path";
	required: true;
	schema: { type: "string" };
};

type OpenApiOperation = {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	parameters?: OpenApiParameter[];
	responses: Record<string, { description: string }>;
};

type OpenApiPathItem = Partial<Record<Lowercase<Route["method"]>, OpenApiOperation>>;

type OpenApiDocument = {
	openapi: "3.1.0";
	info: { title: string; version: string; description: string };
	tags: { name: string; description: string }[];
	paths: Record<string, OpenApiPathItem>;
};

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
	const op: OpenApiOperation = {
		operationId: route.handler,
		tags: [tagFor(route.pattern)],
		summary: `${route.method} ${route.pattern}`,
		responses: {
			"200": { description: "Successful response." },
			default: { description: "Error response (see `src/core/errors.ts`)." },
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
				"Auto-generated from `src/server/handlers/index.ts`'s `ROUTE_TABLE`. " +
				"Run `bun run gen:openapi` to refresh; CI fails if this schema " +
				"drifts from the handler module. Request/response bodies are " +
				"intentionally left permissive in V1 — see SPEC §8.1 for the " +
				"canonical handler contracts.",
		},
		tags,
		paths: sortedPaths,
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
		"# AUTO-GENERATED by `bun run gen:openapi` from `src/server/handlers/index.ts`.",
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
			console.error("docs/openapi.yaml is stale relative to src/server/handlers/index.ts.");
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
