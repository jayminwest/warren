/**
 * `warren register-agent <name>` — clone (or fast-forward) the canopy
 * library, render the named prompt, and upsert it into the warren agents
 * cache. Mirrors `POST /agents/refresh` (src/server/handlers/agents.ts) but scoped to a
 * single agent so an operator can iterate quickly without re-rendering
 * a library of 20+ prompts.
 *
 * Implementation: wrap the live `CanopyClient.listAgents()` so it returns
 * only the named summary, then drive `refreshAgentRegistry` exactly as
 * the HTTP route does. This reuses the per-agent error isolation
 * (mx-5cc992) for free — a render or schema failure for the named
 * prompt lands in `result.skipped[0]`, which we surface with a non-zero
 * exit so CI loops fail loudly.
 */

import type { AgentsRepo } from "../../db/repos/agents.ts";
import { type AgentSummary, CanopyClient } from "../../registry/canopy.ts";
import type { CanopyRegistryConfig } from "../../registry/config.ts";
import { type RefreshResult, refreshAgentRegistry } from "../../registry/refresh.ts";
import type { CliContext } from "../output.ts";
import { formatError, writeJsonLine } from "../output.ts";

export interface RegisterAgentArgs {
	readonly name: string;
}

export interface RegisterAgentDeps {
	readonly agents: AgentsRepo;
	readonly canopyConfig: CanopyRegistryConfig;
	/** Override the live `CanopyClient` (tests). */
	readonly canopyClient?: CanopyClient;
}

export interface RegisterAgentResult {
	readonly exitCode: number;
}

export async function runRegisterAgent(
	context: CliContext,
	deps: RegisterAgentDeps,
	args: RegisterAgentArgs,
): Promise<RegisterAgentResult> {
	if (args.name === "") {
		context.stdio.stderr.write("warren: agent name is required\n");
		return { exitCode: 2 };
	}

	const live =
		deps.canopyClient ??
		CanopyClient.forLibrary({ config: deps.canopyConfig, spawn: context.spawn });
	const filtered = filterToOne(live, args.name);

	let result: RefreshResult;
	try {
		result = await refreshAgentRegistry({
			client: filtered,
			agents: deps.agents,
			cloneOptions: {
				config: deps.canopyConfig,
				spawn: context.spawn,
			},
			...(context.now !== undefined ? { now: context.now } : {}),
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	const registered = result.registered.find((row) => row.name === args.name);
	const skipped = result.skipped.find((entry) => entry.name === args.name);

	if (registered !== undefined) {
		writeJsonLine(context.stdio.stdout, {
			ok: true,
			agent: registered.name,
			lastRefreshed: registered.lastRefreshed,
			cloned: result.clone.cloned,
		});
		return { exitCode: 0 };
	}

	if (skipped !== undefined) {
		writeJsonLine(context.stdio.stdout, {
			ok: false,
			agent: args.name,
			code: skipped.code,
			reason: skipped.reason,
		});
		return { exitCode: 1 };
	}

	writeJsonLine(context.stdio.stdout, {
		ok: false,
		agent: args.name,
		code: "agent_not_found",
		reason: `agent '${args.name}' is not tagged 'agent' in the canopy library`,
	});
	return { exitCode: 1 };
}

/**
 * Wrap a CanopyClient so `listAgents()` returns at most the one summary
 * the operator named. `renderAgent` is unchanged.
 */
function filterToOne(client: CanopyClient, name: string): CanopyClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === "listAgents") {
				return async (): Promise<AgentSummary[]> => {
					const all = await target.listAgents();
					const match = all.find((s) => s.name === name);
					return match !== undefined ? [match] : [];
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
