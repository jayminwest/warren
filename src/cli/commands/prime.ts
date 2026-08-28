/**
 * `warren prime` — agent session bootstrap, half two (warren-fc12,
 * pl-882c step 11). Modeled on `sd prime` / `ml prime`: inject everything
 * an agent needs to drive the warren CLI into context at session start.
 *
 * The document derives from the commander program definition itself
 * (the same source the generated CLI reference, warren-1caf, consumes),
 * so prime output cannot drift from the code. Sections:
 *
 *   commands   name, one-line purpose, key flags — walked from the program
 *   env        the WARREN_BASE_URL / WARREN_API_TOKEN / config-file contract
 *   exitCodes  the stable table from src/cli/output.ts (warren-b61e)
 *   workflows  dispatch-and-wait, tail-and-steer, plan run
 *
 * Output honors the global contract: ndjson (default) / json for machines,
 * pretty for humans.
 */

import type { Command } from "commander";
import { CLIENT_CONFIG_PATH_ENV } from "../../client/config-file.ts";
import { VERSION } from "../../index.ts";
import { type CliContext, EXIT_CODE_TABLE, writeResult } from "../output.ts";
import { collectCommandReference } from "../reference.ts";

export interface PrimeCommand {
	readonly name: string;
	readonly description: string;
	readonly options: readonly { readonly flags: string; readonly description: string }[];
}

export interface PrimeDocument {
	readonly command: "prime";
	readonly version: string;
	readonly commands: readonly PrimeCommand[];
	readonly env: readonly { readonly name: string; readonly summary: string }[];
	readonly exitCodes: typeof EXIT_CODE_TABLE;
	readonly workflows: readonly { readonly name: string; readonly steps: readonly string[] }[];
}

/**
 * The env/config contract an agent must know before dispatching. Exported
 * so the generated CLI reference (warren-1caf) renders the same contract
 * instead of keeping a second copy.
 */
export const ENV_CONTRACT: PrimeDocument["env"] = [
	{ name: "WARREN_BASE_URL", summary: "warren server base URL (default http://localhost:8080)" },
	{
		name: "WARREN_API_TOKEN",
		summary:
			"bearer token for the server (required unless WARREN_AUTH=public); an exported value overrides the client config file, but a cwd `.env` is never auto-loaded (the CLI runs with --env-file=/dev/null) — only variables exported in your shell count (`warren login` still prefers a piped stdin token over the env)",
	},
	{
		name: CLIENT_CONFIG_PATH_ENV,
		summary:
			"override the client config path (default ~/.warren/client.json, written by `warren login`)",
	},
];

/** Canonical agent workflows, in teaching order. */
const WORKFLOWS: PrimeDocument["workflows"] = [
	{
		name: "dispatch-and-wait",
		steps: [
			"warren login --url <base> --token <t>   # once; stores credentials in the client config",
			'warren run <agent> <project-id> -p "<prompt>"   # dispatch, tail NDJSON events, exit with the terminal state',
		],
	},
	{
		name: "tail-and-steer",
		steps: [
			'warren run <agent> <project-id> -p "<prompt>"   # each NDJSON line is one event',
			"Ctrl-C detaches the tail (exit 130); the remote run keeps going",
		],
	},
	{
		name: "plan-run",
		steps: [
			"warren plan run <plan-id> --project <id> --agent <name>   # serial children, each gated on the previous PR merging",
			"warren plan status <plan-run-id>   # child-state table with per-child cost + duration",
			"warren plan cancel <plan-run-id>   # cancel the plan-run and its in-flight child",
		],
	},
];

/**
 * Walk a commander program into the flat command reference. Derived from
 * the shared `collectCommandReference` walk (warren-1caf) so prime and the
 * generated CLI reference can never disagree about the command surface.
 */
export function collectCommands(program: Command): PrimeCommand[] {
	return collectCommandReference(program).map((entry) => ({
		name: entry.name,
		description: entry.description,
		options: entry.options.map(({ flags, description }) => ({ flags, description })),
	}));
}

/** Assemble the full prime document from the live program definition. */
export function buildPrimeDocument(program: Command): PrimeDocument {
	return {
		command: "prime",
		version: VERSION,
		commands: collectCommands(program),
		env: ENV_CONTRACT,
		exitCodes: EXIT_CODE_TABLE,
		workflows: WORKFLOWS,
	};
}

export interface PrimeDeps {
	/** The built commander program (production: `buildProgram` output). */
	readonly program: Command;
}

export async function runPrime(
	context: CliContext,
	deps: PrimeDeps,
): Promise<{ exitCode: number }> {
	const doc = buildPrimeDocument(deps.program);
	writeResult(context, doc, renderPretty(doc));
	return { exitCode: 0 };
}

/** Human-readable rendering for `--output pretty`. */
export function renderPretty(doc: PrimeDocument): string {
	const lines: string[] = [
		`warren prime — agent session context (v${doc.version})`,
		"",
		"Commands:",
	];
	for (const cmd of doc.commands) {
		lines.push(`  ${cmd.name} — ${cmd.description}`);
		for (const opt of cmd.options) {
			lines.push(`      ${opt.flags}  ${opt.description}`);
		}
	}
	lines.push("", "Environment:");
	for (const env of doc.env) {
		lines.push(`  ${env.name} — ${env.summary}`);
	}
	lines.push("", "Exit codes:");
	for (const row of doc.exitCodes) {
		lines.push(`  ${row.code}  ${row.name} — ${row.summary}`);
	}
	lines.push("", "Workflows:");
	for (const wf of doc.workflows) {
		lines.push(`  ${wf.name}:`);
		for (const step of wf.steps) {
			lines.push(`    ${step}`);
		}
	}
	return lines.join("\n");
}
