/**
 * The operator CLI entrypoint (warren-d050).
 *
 * Commands (NDJSON by default; `--format human` for readable output):
 *
 * - `manifest validate` / `manifest import` — validate or durably import an
 *   immutable campaign manifest plus repository-policy snapshot.
 * - `amendment validate` / `amendment apply` — validate or apply a digest-bound
 *   manifest amendment in place (warren-35c4): same campaign row, version
 *   incremented, no superseded attention noise.
 * - `approve` — the explicit human act binding a manifest digest.
 * - `tick` — one deterministic, bounded, restart-safe dry-run tick.
 * - `status` — campaign / work-item state, budget, PR identities.
 * - `journal` — the durable action journal.
 * - `attention list` / `attention ack` — the human-attention queue.
 *
 * The CLI has no command that posts a PR or comment, mutates GitHub,
 * discovers GKE secrets, or enables a live mode. `runCli` is the testable
 * seam: argv, an env source, IO, and the clock/id/fetch injectables go in;
 * the process exit code comes out.
 */

import type { Clock, IdGenerator } from "../clock.ts";
import { SystemClock, UuidIdGenerator } from "../clock.ts";
import type { FetchLike as GithubFetchLike } from "../github/http-transport.ts";
import type { FetchLike } from "../warren-client.ts";
import { runAmendmentApply, runAmendmentValidate } from "./commands/amendment.ts";
import { runManifestImport, runManifestValidate } from "./commands/manifest.ts";
import {
	runApprove,
	runAttentionAck,
	runAttentionList,
	runJournal,
	runStatus,
} from "./commands/store-commands.ts";
import { runTickCommand } from "./commands/tick-command.ts";
import {
	type EnvSource,
	type FlagSource,
	resolveConfig,
	SECRET_FLAGS,
	secretValues,
} from "./config.ts";
import { CliError, EXIT_OK, exitCodeFor } from "./exit-codes.ts";
import { createIo, type OutputFormat } from "./output.ts";

const USAGE = `usage: warren-campaign <command> [flags]

commands:
  manifest validate [--manifest <p>] [--policy <p>]   validate a campaign manifest (+ policy)
  manifest import --manifest <p> --policy <p>         import the immutable campaign
  amendment validate --amendment <p>                  validate a manifest amendment
  amendment apply --amendment <p>                     apply an approved amendment in place
  approve --campaign <id> --digest <sha256> --by <n>  approve a manifest digest
  tick --campaign <id> [--dry-run]                    one dry-run reconciliation tick
  status [--campaign <id>] [--work-item <id>]         campaign / work-item status
  journal [--campaign <id>] [--work-item <id>]        the durable action journal
  attention list --campaign <id> [--all]              open attention items
  attention ack --campaign <id> --id <id>             acknowledge an attention item

global flags:
  --format ndjson|human   output format (default ndjson)
  --db <path>             state store path (or CAMPAIGN_DB_PATH)

paths and URLs come from flags or their named CAMPAIGN_*/WARREN_*/GITHUB_*
environment variables. Secrets enter only through WARREN_API_TOKEN and
GITHUB_TOKEN, never flags. V0 is dry-run only: there is no live mode.`;

/** Injectable defaults so tests stay fully deterministic. */
export interface RunCliOptions {
	readonly env?: EnvSource;
	readonly write?: (text: string) => void;
	readonly clock?: Clock;
	readonly ids?: IdGenerator;
	readonly warrenFetch?: FetchLike;
	readonly githubFetch?: GithubFetchLike;
}

interface ParsedCommand {
	readonly name: string;
	readonly flags: FlagSource;
}

const COMMAND_FLAG_SPECS: Readonly<Record<string, readonly string[]>> = {
	"manifest validate": ["manifest", "policy"],
	"manifest import": ["manifest", "policy"],
	"amendment validate": ["amendment"],
	"amendment apply": ["amendment"],
	approve: ["campaign", "digest", "by"],
	tick: ["campaign", "dry-run"],
	status: ["campaign", "work-item"],
	journal: ["campaign", "work-item"],
	"attention list": ["campaign", "all"],
	"attention ack": ["campaign", "id"],
};

/** Flags that take no value. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["dry-run", "all"]);

const GLOBAL_FLAGS: readonly string[] = ["format", "db"];

/**
 * Parse argv, dispatch one command, and return the process exit code.
 * Exactly one success or error envelope is emitted.
 */
export async function runCli(
	argv: readonly string[],
	options: RunCliOptions = {},
): Promise<number> {
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const env = options.env ?? {};
	let commandName = "cli";
	let commandFlags: FlagSource | undefined;
	try {
		const command = parseCommand(argv);
		commandName = command?.name ?? "cli";
		commandFlags = command?.flags;
		if (command === null) {
			throw new CliError(`no command given\n${USAGE}`);
		}
		const config = resolveConfig(command.flags, env);
		const io = createIo(resolveFormat(command.flags), { write, secrets: secretValues(config) });
		const clock = options.clock ?? new SystemClock();
		const ids = options.ids ?? new UuidIdGenerator();
		const deps = { clock, ids, warrenFetch: options.warrenFetch, githubFetch: options.githubFetch };
		const result = await dispatch(command, config, deps);
		io.emitSuccess(commandName, result);
		return EXIT_OK;
	} catch (error) {
		const io = createIo(errorFormat(commandFlags), { write, secrets: collectSecrets(env) });
		io.emitError(commandName, error);
		return exitCodeFor(error);
	}
}

async function dispatch(
	command: ParsedCommand,
	config: ReturnType<typeof resolveConfig>,
	deps: { clock: Clock; ids: IdGenerator; warrenFetch?: FetchLike; githubFetch?: GithubFetchLike },
): Promise<unknown> {
	switch (command.name) {
		case "manifest validate":
			return runManifestValidate(config, { clock: deps.clock });
		case "manifest import":
			return runManifestImport(config, { clock: deps.clock, ids: deps.ids });
		case "amendment validate":
			return runAmendmentValidate(config, { clock: deps.clock, ids: deps.ids });
		case "amendment apply":
			return runAmendmentApply(config, { clock: deps.clock, ids: deps.ids });
		case "approve":
			return runApprove(config, deps, command.flags);
		case "tick":
			return runTickCommand(config, deps, command.flags);
		case "status":
			return runStatus(config, deps, command.flags);
		case "journal":
			return runJournal(config, deps, command.flags);
		case "attention list":
			return runAttentionList(config, deps, command.flags);
		case "attention ack":
			return runAttentionAck(config, deps, command.flags);
		default:
			throw new CliError(`unknown command: ${command.name}`);
	}
}

/** Parse argv into a command name and its flags, validating the vocabulary. */
function parseCommand(argv: readonly string[]): ParsedCommand | null {
	const words: string[] = [];
	let index = 0;
	while (index < argv.length && !argv[index]?.startsWith("-")) {
		words.push(argv[index] as string);
		index += 1;
	}
	const rest = argv.slice(index);
	const name = resolveCommandName(words);
	if (name === null) {
		if (rest.length === 0 && words.length === 0) {
			return null;
		}
		throw new CliError(`unknown command: ${words.join(" ") || "(empty)"}\n${USAGE}`);
	}
	const spec = COMMAND_FLAG_SPECS[name];
	if (spec === undefined) {
		throw new CliError(`unknown command: ${name}`);
	}
	return { name, flags: parseFlags(rest, spec) };
}

function resolveCommandName(words: readonly string[]): string | null {
	if (words.length === 0) {
		return null;
	}
	if (words[0] === "manifest" || words[0] === "attention" || words[0] === "amendment") {
		if (words.length < 2) {
			throw new CliError(`the '${words[0]}' command needs a subcommand (see usage)\n${USAGE}`);
		}
		return `${words[0]} ${words[1]}`;
	}
	if (words.length === 1) {
		return words[0] as string;
	}
	throw new CliError(`unexpected argument '${words[1]}'\n${USAGE}`);
}

/** Parse `--flag value` / `--flag` pairs against the allowed vocabulary. */
function parseFlags(tokens: readonly string[], allowed: readonly string[]): FlagSource {
	const flags: Record<string, string | true> = {};
	const allowedSet = new Set([...allowed, ...GLOBAL_FLAGS]);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as string;
		if (token === "--live" || token === "--no-dry-run" || token === "--execute") {
			throw new CliError(
				`${token} is refused: V0 is dry-run only and has no live mode; posting a PR requires a separate owner approval over a code revision that adds the exact mutation`,
			);
		}
		if (!token.startsWith("--")) {
			throw new CliError(`unexpected argument '${token}'\n${USAGE}`);
		}
		const name = token.slice(2);
		if (SECRET_FLAGS.includes(name)) {
			throw new CliError(
				`--${name} is refused: secrets enter only through the WARREN_API_TOKEN and GITHUB_TOKEN environment variables`,
			);
		}
		if (!allowedSet.has(name)) {
			throw new CliError(`unknown flag --${name} for this command\n${USAGE}`);
		}
		const next = tokens[index + 1];
		if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) {
			flags[name] = true;
			index += 1;
			continue;
		}
		flags[name] = next;
		index += 2;
	}
	return flags;
}

function resolveFormat(flags: FlagSource): OutputFormat {
	const value = flags.format;
	if (value === undefined || value === "ndjson") {
		return "ndjson";
	}
	if (value === "human") {
		return "human";
	}
	throw new CliError(`unknown --format '${String(value)}' (expected ndjson or human)`);
}

/** Best-effort format for the error path; falls back to ndjson. */
function errorFormat(flags: FlagSource | undefined): OutputFormat {
	if (flags === undefined) {
		return "ndjson";
	}
	try {
		return resolveFormat(flags);
	} catch {
		return "ndjson";
	}
}

/** Secret values for the error path, where config resolution may have failed. */
function collectSecrets(env: EnvSource): string[] {
	return [env.WARREN_API_TOKEN, env.GITHUB_TOKEN].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
}
