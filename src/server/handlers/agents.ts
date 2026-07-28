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
import { type RefreshProjectResult, refreshProjectAgents } from "../../registry/refresh.ts";
import { readProviderFrontmatter } from "../../registry/schema.ts";
import { collectedErrorMessage, errorLogFields } from "../errors.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { Actor, RouteContext, RouteHandler, ServerDeps } from "../types.ts";
import { defaultSpawn, requireParam } from "./index.ts";

/**
 * The three frontmatter facts a caller needs to tell two agents apart —
 * lifted out of `renderedJson` onto the row (warren-4f6c / pl-b82d step
 * 15) so the public projection can keep them while dropping the rendered
 * envelope wholesale. `renderedJson` is free-form (canopy authors put
 * whatever they like in `frontmatter`), so narrowing it in place would be
 * a denylist; hoisting the named fields keeps the allowlist rule intact.
 */
export interface AgentMetadata {
	readonly description: string | null;
	readonly provider: string | null;
	readonly model: string | null;
}

/** An `agents` row as every `GET /agents` consumer sees it. */
export type DecoratedAgent = AgentRow & AgentMetadata & { source: AgentSource };

function readAgentMetadata(rendered: unknown): AgentMetadata {
	if (rendered === null || typeof rendered !== "object") {
		return { description: null, provider: null, model: null };
	}
	const fm = (rendered as { frontmatter?: unknown }).frontmatter;
	if (fm === null || fm === undefined || typeof fm !== "object") {
		return { description: null, provider: null, model: null };
	}
	const frontmatter = fm as Readonly<Record<string, unknown>>;
	const { provider, model } = readProviderFrontmatter(frontmatter);
	const description = frontmatter.description;
	return {
		description: typeof description === "string" && description.length > 0 ? description : null,
		provider: provider ?? null,
		model: model ?? null,
	};
}

/**
 * Decorate an `AgentRow` with the `source` provenance so `GET /agents`
 * consumers can distinguish built-ins from library-loaded agents, plus the
 * flat `description` / `provider` / `model` metadata (warren-4f6c).
 */
export function withAgentSource(row: AgentRow): DecoratedAgent {
	return {
		...row,
		...readAgentMetadata(row.renderedJson),
		source: readAgentSource(row.renderedJson),
	};
}

/**
 * The agent fields a `readPublic`-only spectator sees (warren-4f6c /
 * pl-b82d step 15). An allowlist, so a column or decoration added
 * tomorrow is absent from the public body until someone classifies it
 * here — see `src/server/projection.ts` for why this is never a denylist.
 */
export const PUBLIC_AGENT_FIELDS = [
	"id",
	"projectId",
	"name",
	"registeredAt",
	"lastRefreshed",
	"source",
	"description",
	"provider",
	"model",
] as const satisfies readonly (keyof DecoratedAgent)[];

/**
 * The complement of `PUBLIC_AGENT_FIELDS`, spelled out so the
 * classification is a decision on record rather than "whatever fell off
 * the list", and so `public-projections.test.ts` can assert the two
 * partition `DecoratedAgent`.
 *
 * - `renderedJson` — the whole rendered envelope: `sections.system` is the
 *   agent's full system prompt (the prompt engineering IS the IP here),
 *   `sections.burrow_config` is sandbox policy, and `resolvedFrom` carries
 *   canopy source paths. The parts worth showing a spectator are hoisted
 *   onto the row by `withAgentSource`.
 */
export const REDACTED_AGENT_FIELDS = [
	"renderedJson",
] as const satisfies readonly (keyof DecoratedAgent)[];

/** A decorated agent as a `readPublic`-only caller sees it. */
export type PublicAgent = Pick<DecoratedAgent, (typeof PUBLIC_AGENT_FIELDS)[number]>;

/**
 * Narrow one decorated agent for `actor`. The operator gets the decorated
 * row untouched, so the public body is provably the operator body minus
 * fields — one construction site, no drift.
 */
function projectAgent(row: DecoratedAgent, actor: Actor | undefined): DecoratedAgent | PublicAgent {
	return isPublicOnly(actor) ? pickFields(row, PUBLIC_AGENT_FIELDS) : row;
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
		return jsonResponse(200, {
			agents: rows.map((row) => projectAgent(withAgentSource(row), ctx.actor)),
		});
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
				recoveryHint:
					"POST /projects/:id/agents/refresh to re-discover from a project .canopy/ tier",
			});
		}
		return jsonResponse(200, projectAgent(withAgentSource(row), ctx.actor));
	};
}

/**
 * Per-project refresh error, surfaced in a response envelope so the
 * operator can spot a project whose `.canopy/` is misconfigured. The
 * library tier and its all-projects refresh loop were removed in
 * warren-5652; `collectProjectRefreshError` remains the shared
 * body/log disclosure helper (warren-bf4c) for per-project failures.
 *
 * `message` is a FIXED stand-in, never the caught error's own text
 * (warren-bf4c) — see `collectProjectRefreshError`.
 */
interface ProjectRefreshError {
	readonly projectId: string;
	readonly code: string;
	readonly message: string;
}

/**
 * Map one caught per-project refresh failure onto its wire row, and send
 * the real error to the request logger (warren-bf4c — same disclosure
 * class as warren-4385).
 *
 * The loop catches whatever `refreshProjectAgents` threw, which is
 * usually a `CanopyUnavailableError` whose message interpolates `cn`
 * stderr and the project's absolute `localPath`, and can be any untyped
 * error from a deeper layer. None of that belongs in a response, so the
 * row carries `collectedErrorMessage()` and the detail goes to
 * `ctx.logger` — already bound to the same `request_id` the message
 * quotes, so an operator loses nothing.
 *
 * `code` survives because it is a machine label rather than free text,
 * but it is shape-checked: an arbitrary thrown object can carry any
 * string under `code`, and that would reopen the hole `message` just
 * closed.
 */
export function collectProjectRefreshError(
	projectId: string,
	err: unknown,
	ctx: Pick<RouteContext, "logger" | "requestId">,
): ProjectRefreshError {
	ctx.logger.error({ ...errorLogFields(err), projectId }, "agents.refresh_project_tier_failed");
	return {
		projectId,
		code: errorCode(err),
		message: collectedErrorMessage(ctx.requestId),
	};
}

/** Per-project refresh outcome used by both the all-projects loop and
 * the per-project route. Mirrors `RefreshProjectResult` but stamped
 * with the post-`withAgentSource` row shape so consumers see the
 * provenance label without a second read. */
type ProjectRefreshOutcome = Omit<RefreshProjectResult, "registered"> & {
	readonly registered: DecoratedAgent[];
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
 * The cn binary is "cn" on PATH.
 */
export function projectCanopyClient(deps: ServerDeps, projectPath: string): CanopyClient {
	return CanopyClient.forProjectPath({
		projectPath,
		cnBinary: "cn",
		// Route project-tier spawns through deps.spawn (when set) so tests
		// can stub `cn list`/`cn render` without touching PATH — same seam
		// `POST /projects/:id/refresh` uses for git.
		spawn: deps.spawn ?? defaultSpawn,
	});
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
 * Shape a stable machine code has: a bare identifier. `canopy_unavailable`,
 * `agent_schema_error`, a node `ENOENT`. Anything else — a sentence, a
 * path, a command line — is prose wearing a `code` field and is dropped
 * (warren-bf4c).
 */
const ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/i;

/**
 * Best-effort extraction of a `code` string off an error caught in the
 * all-projects refresh loop. Canopy/Warren errors carry one; arbitrary
 * Errors fall back to a generic label, as does any `code` that isn't
 * identifier-shaped — the row's `message` is fixed (warren-bf4c), so an
 * unvetted `code` would be the remaining way for caught text to reach the
 * response.
 */
function errorCode(err: unknown): string {
	if (err !== null && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code;
		if (typeof code === "string" && ERROR_CODE_SHAPE.test(code)) return code;
	}
	return "internal_error";
}
