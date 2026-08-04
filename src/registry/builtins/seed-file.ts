/**
 * Operator-supplied extra agent definitions seeded at server boot
 * (warren-e376).
 *
 * The canopy library tier was deleted in pl-3a79, leaving the registry
 * built-ins-only. Self-hosters (and the acceptance harness, which needs
 * its deterministic `stub-shell` agent registered before any spawn) can
 * point `WARREN_SEED_AGENTS_FILE` at a JSON array of `AgentDefinition`
 * objects; the server seeds them alongside the built-ins on every boot.
 *
 * Seeding rides `seedBuiltinAgents`, so it is idempotent and
 * drift-aware: rows whose `frontmatter.source` is `"builtin"` are
 * upserted when the file's definition changes; anything else is
 * preserved untouched.
 */

import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { AgentsRepo } from "../../db/repos/agents.ts";
import { AgentNameSchema } from "../agent-name.ts";
import type { AgentDefinition } from "../schema.ts";
import { type RejectedAgentSeed, seedBuiltinAgents } from "./index.ts";

export const SEED_AGENTS_FILE_ENV = "WARREN_SEED_AGENTS_FILE";

const SeedAgentSchema = z.object({
	// warren-2b75: same kebab grammar as RoleNameSchema / canopy render output,
	// so a name the router would refuse fails at boot with a useful message.
	name: AgentNameSchema,
	version: z.number().int().positive(),
	sections: z.record(z.string(), z.string()),
	resolvedFrom: z.array(z.string()),
	frontmatter: z.record(z.string(), z.unknown()),
});

const SeedAgentsFileSchema = z.array(SeedAgentSchema);

export class SeedAgentsFileError extends Error {
	constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "SeedAgentsFileError";
	}
}

/**
 * Read + validate the seed-agents file. Throws `SeedAgentsFileError`
 * with the offending path when the file is unreadable, not JSON, or
 * fails the `AgentDefinition` shape — boot surfaces that loudly rather
 * than silently skipping operator-supplied agents.
 */
export async function loadSeedAgentsFromFile(path: string): Promise<AgentDefinition[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		throw new SeedAgentsFileError(
			`${SEED_AGENTS_FILE_ENV}: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new SeedAgentsFileError(`${SEED_AGENTS_FILE_ENV}: ${path} is not valid JSON`, {
			cause: err,
		});
	}
	const result = SeedAgentsFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new SeedAgentsFileError(
			`${SEED_AGENTS_FILE_ENV}: ${path} failed validation: ${result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
		);
	}
	return result.data;
}

export interface SeedAgentsFromEnvResult {
	readonly path: string;
	readonly seeded: readonly string[];
	/** Definitions the seeder refused; boot warns and continues (warren-c4be). */
	readonly rejected: readonly RejectedAgentSeed[];
}

/**
 * Boot hook (warren-e376): when `WARREN_SEED_AGENTS_FILE` is set, load
 * the file and seed its definitions through the same idempotent path as
 * the built-ins. Returns null when the var is unset/empty. The
 * acceptance harness uses this to register its stub-shell agent now
 * that POST /agents/refresh is gone (pl-3a79).
 */
export async function seedAgentsFromEnvFile(
	repo: AgentsRepo,
	env: Readonly<Record<string, string | undefined>>,
	now?: () => Date,
): Promise<SeedAgentsFromEnvResult | null> {
	const path = env[SEED_AGENTS_FILE_ENV];
	if (path === undefined || path === "") return null;
	const agents = await loadSeedAgentsFromFile(path);
	const result = await seedBuiltinAgents(repo, agents, now);
	return { path, seeded: result.seeded, rejected: result.rejected };
}
