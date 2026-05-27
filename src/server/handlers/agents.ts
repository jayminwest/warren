/**
 * Agents handlers (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. ROUTE_TABLE stays in `index.ts`;
 * shared helpers (`readJsonBody`, `requireParam`, `defaultSpawn`,
 * `parseProjectIdQuery`-equivalent inline) are re-imported from the
 * index module — same pattern phase 1 / phase 2 established
 * (mx-3df5c5, mx-99ad0d).
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { AgentRow } from "../../db/schema.ts";
import { type AgentSource, readAgentSource } from "../../registry/builtins/index.ts";
import { CanopyClient } from "../../registry/canopy.ts";
import {
	type RefreshProjectResult,
	refreshAgentRegistry,
	refreshProjectAgents,
} from "../../registry/refresh.ts";
import { jsonResponse } from "../response.ts";
import type { RouteContext, RouteHandler, ServerDeps } from "../types.ts";
import { defaultSpawn, requireParam } from "./index.ts";

/**
 * Decorate an `AgentRow` with the `source` provenance so `GET /agents`
 * consumers can distinguish built-ins from library-loaded agents.
 */
export function withAgentSource(row: AgentRow): AgentRow & { source: AgentSource } {
	return { ...row, source: readAgentSource(row.renderedJson) };
}

/**
 * Optional `?projectId=` filter (R-03 / pl-fef5 step 6). Empty string is
 * rejected so a typo'd query (`?projectId=`) surfaces instead of
 * silently collapsing to global-only.
 */
function parseProjectIdQuery(ctx: RouteContext): string | undefined {
	const raw = ctx.url.searchParams.get("projectId");
	if (raw === null) return undefined;
	if (raw.length === 0) {
		throw new ValidationError("?projectId must be a non-empty string");
	}
	return raw;
}

export function listAgentsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = parseProjectIdQuery(ctx);
		const rows = await deps.repos.agents.listAll(projectId !== undefined ? { projectId } : {});
		return jsonResponse(200, { agents: rows.map(withAgentSource) });
	};
}

export function getAgentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const name = requireParam(ctx, "name");
		const projectId = parseProjectIdQuery(ctx);
		const row =
			projectId !== undefined
				? await deps.repos.agents.resolve(name, { projectId })
				: await deps.repos.agents.get(name);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`, {
				recoveryHint: "POST /agents/refresh to re-discover from canopy",
			});
		}
		return jsonResponse(200, withAgentSource(row));
	};
}

/**
 * Per-project refresh error caught by `POST /agents/refresh`'s all-
 * projects loop. Surfaced in the response envelope so the operator
 * can spot a project whose `.canopy/` is misconfigured without
 * tanking the library half of the refresh.
 */
interface ProjectRefreshError {
	readonly projectId: string;
	readonly code: string;
	readonly message: string;
}

/** Per-project refresh outcome used by both the all-projects loop and
 * the per-project route. Mirrors `RefreshProjectResult` but stamped
 * with the post-`withAgentSource` row shape so consumers see the
 * provenance label without a second read. */
type ProjectRefreshOutcome = Omit<RefreshProjectResult, "registered"> & {
	readonly registered: (AgentRow & { source: AgentSource })[];
};

function decorateRefreshResult(result: RefreshProjectResult): ProjectRefreshOutcome {
	return {
		projectId: result.projectId,
		registered: result.registered.map(withAgentSource),
		skipped: result.skipped,
		removed: result.removed,
	};
}

/**
 * Build a `CanopyClient` rooted at a project's working tree so
 * `cn list`/`cn render` resolve against `<projectPath>/.canopy/`.
 * The cn binary defaults to whatever the library tier configured
 * (`canopyConfig.cnBinary`, ultimately `WARREN_CN_BINARY`); without
 * a library configured we fall back to "cn" on PATH.
 */
export function projectCanopyClient(deps: ServerDeps, projectPath: string): CanopyClient {
	return CanopyClient.forProjectPath({
		projectPath,
		cnBinary: deps.canopyConfig?.cnBinary ?? "cn",
		// Route project-tier spawns through deps.spawn (when set) so tests
		// can stub `cn list`/`cn render` without touching PATH — same seam
		// `POST /projects/:id/refresh` uses for git.
		spawn: deps.spawn ?? defaultSpawn,
	});
}

export function refreshAgentsHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		// No canopy library configured (warren-d3e9): refresh has nothing
		// to refresh against. 400 with a friendly hint is more useful than
		// 200-with-empty-arrays — the operator's mental model is "I asked
		// for a refresh, why didn't anything happen". Project-tier refresh
		// is still available via POST /projects/:id/agents/refresh.
		if (deps.canopyConfig === undefined) {
			throw new ValidationError("CANOPY_REPO_URL is not set; nothing to refresh", {
				recoveryHint:
					"set CANOPY_REPO_URL to a canopy agent library to enable refresh — built-in agents are always available without one, and POST /projects/:id/agents/refresh handles project-tier .canopy/",
			});
		}
		const canopyConfig = deps.canopyConfig;
		const client = CanopyClient.forLibrary({ config: canopyConfig, spawn: defaultSpawn });
		const libraryResult = await refreshAgentRegistry({
			client,
			agents: deps.repos.agents,
			cloneOptions: {
				config: canopyConfig,
				spawn: defaultSpawn,
			},
		});

		// After the library pass, scan every project's .canopy/ tier
		// (pl-fef5 acceptance #3). Per-project failures (missing .canopy,
		// malformed prompts, cn binary AWOL inside one project) are
		// collected — one bad project must not poison the batch.
		const projects = await deps.repos.projects.listAll();
		const projectOutcomes: ProjectRefreshOutcome[] = [];
		const projectErrors: ProjectRefreshError[] = [];
		for (const project of projects) {
			try {
				const result = await refreshProjectAgents({
					client: projectCanopyClient(deps, project.localPath),
					agents: deps.repos.agents,
					projectId: project.id,
					projectPath: project.localPath,
				});
				projectOutcomes.push(decorateRefreshResult(result));
			} catch (err) {
				projectErrors.push({
					projectId: project.id,
					code: errorCode(err),
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return jsonResponse(200, {
			clone: libraryResult.clone,
			registered: libraryResult.registered,
			skipped: libraryResult.skipped,
			removed: libraryResult.removed,
			projects: projectOutcomes,
			projectErrors,
		});
	};
}

export function refreshProjectAgentsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const project = await deps.repos.projects.require(id);
		const result = await refreshProjectAgents({
			client: projectCanopyClient(deps, project.localPath),
			agents: deps.repos.agents,
			projectId: project.id,
			projectPath: project.localPath,
		});
		return jsonResponse(200, decorateRefreshResult(result));
	};
}

/**
 * Best-effort extraction of a `code` string off an error caught in the
 * all-projects refresh loop. Canopy/Warren errors carry one; arbitrary
 * Errors fall back to a generic label.
 */
function errorCode(err: unknown): string {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code;
		if (typeof code === "string") return code;
	}
	return "internal_error";
}
