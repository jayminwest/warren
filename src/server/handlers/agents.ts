/**
 * Agents handlers (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. ROUTE_TABLE stays in `index.ts`;
 * shared helpers (`requireParam`) are re-imported from the index module —
 * same pattern phase 1 / phase 2 established (mx-3df5c5, mx-99ad0d).
 */

import { NotFoundError } from "../../core/errors.ts";
import { type AgentSource, readAgentSource } from "../../registry/builtins/index.ts";
import type { AgentDbRow } from "../../registry/index.ts";
import { readProviderFrontmatter } from "../../registry/schema.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

/**
 * The three frontmatter facts a caller needs to tell two agents apart —
 * lifted out of `renderedJson` onto the row (warren-4f6c / pl-b82d step
 * 15) so the public projection can keep them while dropping the rendered
 * envelope wholesale. `renderedJson` is free-form (agent authors put
 * whatever they like in `frontmatter`), so narrowing it in place would be
 * a denylist; hoisting the named fields keeps the allowlist rule intact.
 */
export interface AgentMetadata {
	readonly description: string | null;
	readonly provider: string | null;
	readonly model: string | null;
}

/** An `agents` row as every `GET /agents` consumer sees it. */
export type DecoratedAgent = AgentDbRow & AgentMetadata & { source: AgentSource };

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
 * Decorate an `AgentDbRow` with the `source` provenance so `GET /agents`
 * consumers can distinguish built-ins from library-loaded agents, plus the
 * flat `description` / `provider` / `model` metadata (warren-4f6c).
 */
export function withAgentSource(row: AgentDbRow): DecoratedAgent {
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
 *   `sections.burrow_config` is sandbox policy. The parts worth showing a
 *   spectator are hoisted onto the row by `withAgentSource`.
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

export function listAgentsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const rows = await deps.repos.agents.listAll();
		return jsonResponse(200, {
			agents: rows.map((row) => projectAgent(withAgentSource(row), ctx.actor)),
		});
	};
}

export function getAgentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const name = requireParam(ctx, "name");
		const row = await deps.repos.agents.get(name);
		if (!row) {
			throw new NotFoundError(`agent not found: ${name}`);
		}
		return jsonResponse(200, projectAgent(withAgentSource(row), ctx.actor));
	};
}
