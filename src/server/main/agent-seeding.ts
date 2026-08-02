/**
 * Boot-time agent seeding (warren-d3e9 / warren-e376) and its narration.
 *
 * Two idempotent passes over the agents table: the inline built-ins, then
 * the optional `WARREN_SEED_AGENTS_FILE` payload. Neither pass can take the
 * boot down (warren-c4be) — a definition the registry refuses, such as one
 * pinning a burrow runtime id outside the accepted vocabulary, is reported
 * on `rejected`, logged at `warn`, and simply never registers. Boot always
 * completes and `/healthz` always comes up; the bad row stays unusable
 * rather than reaching burrow mid-dispatch.
 */

import type { AgentsRepo } from "../../db/repos/agents.ts";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { seedAgentsFromEnvFile } from "../../registry/builtins/seed-file.ts";
import type { Logger } from "../types.ts";

export interface SeedAgentsAtBootInput {
	readonly repo: AgentsRepo;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/** Run both seeding passes and narrate the outcome. Never throws on a refusal. */
export async function seedAgentsAtBoot(input: SeedAgentsAtBootInput): Promise<void> {
	const { repo, env, logger, now } = input;

	const builtins = await seedBuiltinAgents(repo, undefined, now);
	if (builtins.seeded.length > 0) {
		logger.info({ agents: builtins.seeded }, "seeded built-in agents");
	}
	if (builtins.rejected.length > 0) {
		logger.warn({ rejected: builtins.rejected }, "refused to seed built-in agents");
	}

	const extra = await seedAgentsFromEnvFile(repo, env, now);
	if (extra === null) return;
	if (extra.seeded.length > 0) {
		logger.info({ agents: extra.seeded, path: extra.path }, "seeded seed-file agents");
	}
	if (extra.rejected.length > 0) {
		logger.warn({ rejected: extra.rejected, path: extra.path }, "refused to seed seed-file agents");
	}
}
