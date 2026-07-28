/**
 * `refreshProjectAgents` — the operation behind
 * `POST /projects/:id/agents/refresh` (R-03 / pl-fef5). Scans a
 * project's `<projectPath>/.canopy/` tier via the `cn` CLI, renders and
 * validates each agent, and upserts it at the project scope.
 *
 * The library tier (`CANOPY_REPO_URL` clone path, `refreshAgentRegistry`,
 * `POST /agents/refresh`) was removed in warren-5652 — warren ships
 * built-in agents inline (`src/registry/builtins/`) and per-project
 * `.canopy/` is the only remaining canopy-sourced tier.
 *
 * Per-agent failures are *collected*, not thrown: one bad prompt
 * shouldn't block the operator from seeing the others register cleanly.
 *
 * Transport-level failures (canopy unreachable, `cn` binary missing)
 * abort the whole refresh — there's nothing useful to partially register
 * if the registry is unreadable.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsRepo } from "../db/repos/agents.ts";
import type { AgentRow } from "../db/schema.ts";
import { makeProjectAgentSource, stampAgentSource } from "./builtins/index.ts";
import type { AgentSummary, CanopyClient } from "./canopy.ts";
import { composeAgent, type ResolveParent, rawPromptHasParents } from "./compose.ts";
import { AgentSchemaError, CanopyUnavailableError } from "./errors.ts";
import { type AgentDefinition, parseRenderedAgent, validateAgentDefinition } from "./schema.ts";

export interface RefreshSkipped {
	readonly name: string;
	readonly reason: string;
	readonly code: string;
}

type RegisterOutcome =
	| { kind: "registered"; row: AgentRow }
	| { kind: "skipped"; skipped: RefreshSkipped };

export interface RefreshProjectOptions {
	readonly client: CanopyClient;
	readonly agents: AgentsRepo;
	/** Project whose `.canopy/` is being scanned. Stamped onto each row's source. */
	readonly projectId: string;
	/**
	 * Project working tree. When set, each registered agent's rendered JSON
	 * is mirrored to `<projectPath>/.canopy/.rendered/<name>.json` (warren-44e3
	 * follow-up to R-03 / pl-fef5) so `cn render` and other non-warren
	 * consumers can see what a project-tier agent resolves to without going
	 * through the agents-table. Omit to skip the on-disk cache (unit tests).
	 */
	readonly projectPath?: string;
	/**
	 * Override the on-disk cache writer. Defaults to `defaultRenderedCacheWriter`,
	 * which writes JSON via `node:fs/promises`. Only consulted when
	 * `projectPath` is set.
	 */
	readonly cacheWriter?: RenderedCacheWriter;
	readonly now?: () => Date;
}

export interface RefreshProjectResult {
	readonly projectId: string;
	readonly registered: AgentRow[];
	readonly skipped: RefreshSkipped[];
	readonly removed: string[];
}

/** Path of the on-disk rendered cache inside a project working tree. */
export const RENDERED_CACHE_SUBPATH = join(".canopy", ".rendered");

/**
 * Subset of agent-name characters safe to use as a filesystem path
 * component for the rendered cache. Canopy itself constrains prompt names
 * to roughly this shape, but the registry boundary re-validates so a
 * malformed name can never escape `<projectPath>/.canopy/.rendered/`.
 */
const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isSafeAgentName(name: string): boolean {
	return SAFE_AGENT_NAME_RE.test(name);
}

/**
 * Filesystem-side companion to the agents-table cache. Implementations
 * write a JSON document per project agent and prune entries when a
 * project-scoped row is removed. The writer is invoked once per
 * `refreshProjectAgents` call when `projectPath` is set:
 *   - `init` is called once before iterating prompts (seeds the
 *     `.gitignore` marker so the cache stays out of project commits).
 *   - `write` is called per successfully-registered agent, in upsert order.
 *   - `prune` is called per agent removed from the project tier.
 */
export interface RenderedCacheWriter {
	init(projectPath: string): Promise<void>;
	write(projectPath: string, name: string, definition: AgentDefinition): Promise<void>;
	prune(projectPath: string, name: string): Promise<void>;
}

/**
 * Default writer: `<projectPath>/.canopy/.rendered/<name>.json`, with a
 * self-ignoring `.gitignore` (`*\n`) seeded at init time. The directory
 * is created if missing. Unsafe agent names are skipped silently — the
 * agents-table row is still the authoritative cache.
 */
export const defaultRenderedCacheWriter: RenderedCacheWriter = {
	async init(projectPath) {
		const dir = join(projectPath, RENDERED_CACHE_SUBPATH);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, ".gitignore"), "*\n");
	},
	async write(projectPath, name, definition) {
		if (!isSafeAgentName(name)) return;
		const dir = join(projectPath, RENDERED_CACHE_SUBPATH);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${name}.json`), `${JSON.stringify(definition, null, 2)}\n`);
	},
	async prune(projectPath, name) {
		if (!isSafeAgentName(name)) return;
		await rm(join(projectPath, RENDERED_CACHE_SUBPATH, `${name}.json`), { force: true });
	},
};

/**
 * Project-tier counterpart to `refreshAgentRegistry`. Scans the project's
 * `.canopy/` (via a `CanopyClient.forProjectPath(...)` the caller wires up),
 * renders each agent, stamps `frontmatter.source = "project:<projectId>"`,
 * and upserts at the project scope so global rows of the same name are
 * untouched.
 *
 * Per-agent failures are collected into `skipped` rather than thrown — one
 * malformed `.canopy/` prompt must not take down the whole project refresh
 * (and step 6's all-projects loop relies on this).
 *
 * Transport-level failures (cn binary missing, `.canopy/` unreadable) abort
 * the whole refresh; the caller (`POST /agents/refresh`'s all-projects loop)
 * is responsible for catching them so one bad project doesn't poison the
 * batch.
 *
 * Pruning is always-on for the project tier: the project's `.canopy/` is
 * the authoritative source for that tier, so any project-scoped row whose
 * name disappears from the listing is removed. The library refresh defaults
 * prune=off because a missed git fetch could nuke the registry; the project
 * tier has no equivalent race.
 */
export async function refreshProjectAgents(
	opts: RefreshProjectOptions,
): Promise<RefreshProjectResult> {
	const summaries = await opts.client.listAgents();
	const cacheWriter =
		opts.projectPath !== undefined ? (opts.cacheWriter ?? defaultRenderedCacheWriter) : null;
	if (cacheWriter !== null && opts.projectPath !== undefined) {
		await cacheWriter.init(opts.projectPath);
	}

	const seen = new Set<string>();
	const registered: AgentRow[] = [];
	const skipped: RefreshSkipped[] = [];

	for (const summary of summaries) {
		seen.add(summary.name);
		const outcome = await registerOneProject(opts, summary, cacheWriter);
		if (outcome.kind === "registered") {
			registered.push(outcome.row);
		} else {
			skipped.push(outcome.skipped);
		}
	}

	const removed: string[] = [];
	for (const existing of await opts.agents.listForProject(opts.projectId)) {
		if (!seen.has(existing.name)) {
			await opts.agents.delete(existing.name, { projectId: opts.projectId });
			removed.push(existing.name);
			if (cacheWriter !== null && opts.projectPath !== undefined) {
				await cacheWriter.prune(opts.projectPath, existing.name);
			}
		}
	}

	return { projectId: opts.projectId, registered, skipped, removed };
}

async function registerOneProject(
	opts: RefreshProjectOptions,
	summary: AgentSummary,
	cacheWriter: RenderedCacheWriter | null,
): Promise<RegisterOutcome> {
	const rendered = await renderAndParse(opts.client, summary);
	let definition: AgentDefinition;
	if (rendered.kind === "rendered") {
		definition = rendered.definition;
	} else {
		// Render failed — attempt cross-tier composition (warren-44a3). Most
		// canopy failures here mean a parent named under `extends:` lives in
		// a different tier (library/built-in) and canopy bailed because the
		// name isn't in this project's `.canopy/`. We rebuild the agent by
		// fetching the raw prompt and walking parents through the project →
		// global resolver. If the prompt has no `extends`/`mixins`, or the
		// composer can't satisfy the chain either, fall back to the original
		// canopy skip so the operator sees the most actionable error.
		const composed = await tryCompose(opts, summary);
		if (composed === null) return rendered;
		if (composed.kind === "skipped") {
			return { kind: "skipped", skipped: composed.skipped };
		}
		definition = composed.definition;
	}
	const stamped = stampAgentSource(definition, makeProjectAgentSource(opts.projectId));
	const row = await opts.agents.upsert({
		name: stamped.name,
		projectId: opts.projectId,
		renderedJson: stamped,
		now: opts.now?.(),
	});
	if (cacheWriter !== null && opts.projectPath !== undefined) {
		await cacheWriter.write(opts.projectPath, stamped.name, stamped);
	}
	return { kind: "registered", row };
}

type ComposeOutcome =
	| { kind: "definition"; definition: AgentDefinition }
	| { kind: "skipped"; skipped: RefreshSkipped };

/**
 * Cross-tier compose fallback (warren-44a3). Returns `null` when there's
 * nothing to compose (raw fetch failed, focal not on disk, or no
 * inheritance to resolve) so the caller keeps the original canopy skip;
 * returns a `ComposeOutcome` when compose either produced a definition
 * or threw a per-agent error we surface as a skip.
 */
async function tryCompose(
	opts: RefreshProjectOptions,
	summary: AgentSummary,
): Promise<ComposeOutcome | null> {
	let raw: Awaited<ReturnType<CanopyClient["showAgent"]>>;
	try {
		raw = await opts.client.showAgent(summary.name);
	} catch (err) {
		if (err instanceof CanopyUnavailableError) return null;
		throw err;
	}
	if (raw === null) return null;
	if (!rawPromptHasParents(raw)) return null;

	const resolve: ResolveParent = async (name, visited) => {
		// Walk past name shadows (warren-44a3 open question): when the
		// parent reference already appears in the resolution chain, treating
		// the project-tier shadow as the parent would loop. Skip project
		// tier in that case and resolve directly against the global tier so
		// `project:foo → library:foo` (or `project:foo → builtin:foo`)
		// composes cleanly. The project shadow still wins as the LEAF for
		// `(name, projectId)` lookups — only the parent resolution walks
		// past.
		if (!visited.includes(name)) {
			try {
				const projectRaw = await opts.client.showAgent(name);
				if (projectRaw !== null) {
					return { kind: "project", raw: projectRaw };
				}
			} catch (err) {
				if (!(err instanceof CanopyUnavailableError)) throw err;
				// Treat any canopy-side miss as "not at this tier" and let
				// the global agents repo settle it.
			}
		}
		const globalRow = await opts.agents.get(name);
		if (globalRow !== null) {
			return { kind: "global", definition: globalRow.renderedJson as AgentDefinition };
		}
		return null;
	};

	try {
		const composed = await composeAgent({ raw, resolve });
		validateAgentDefinition(composed);
		return { kind: "definition", definition: composed };
	} catch (err) {
		if (err instanceof AgentSchemaError || err instanceof CanopyUnavailableError) {
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
}

type RenderedOutcome =
	| { kind: "rendered"; definition: AgentDefinition }
	| { kind: "skipped"; skipped: RefreshSkipped };

async function renderAndParse(
	client: CanopyClient,
	summary: AgentSummary,
): Promise<RenderedOutcome> {
	let raw: unknown;
	try {
		raw = await client.renderAgent(summary.name);
	} catch (err) {
		if (err instanceof CanopyUnavailableError) {
			// A render-time canopy error for one prompt (e.g. "Prompt not found"
			// after a race with `cn archive`) is per-prompt, not catastrophic.
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
	try {
		return { kind: "rendered", definition: parseRenderedAgent(raw, summary.name) };
	} catch (err) {
		if (err instanceof AgentSchemaError) {
			return {
				kind: "skipped",
				skipped: { name: summary.name, code: err.code, reason: err.message },
			};
		}
		throw err;
	}
}
