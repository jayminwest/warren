/**
 * CLI command-surface extraction (warren-1caf, pl-882c step 13).
 *
 * The single walk that turns the commander program definition
 * (`buildProgram` in `src/cli/main.ts`) into plain data. Two consumers:
 *
 *   - `warren prime` (`src/cli/commands/prime.ts`) maps it down to the
 *     leaner session-context shape it prints at agent session start;
 *   - the generated CLI reference (`scripts/generate-cli-reference.ts`)
 *     renders it to `docs/cli-reference.md`.
 *
 * Both derive from the live program definition, so a refactor of the
 * `.command(...)` chains updates every consumer at once — the published
 * reference cannot drift from the code.
 */

import type { Argument, Command, Option } from "commander";

/** One positional argument of a command, in declared order. */
export interface CommandArgument {
	readonly name: string;
	readonly required: boolean;
	readonly variadic: boolean;
	readonly description: string;
}

/** One flag of a command, in declared order. */
export interface CommandOption {
	readonly flags: string;
	readonly description: string;
	/** True when the flag itself is mandatory (commander `requiredOption`). */
	readonly mandatory: boolean;
	readonly defaultValue?: unknown;
}

/** One command in the tree, flattened to its full path (`plan run`). */
export interface CommandEntry {
	/** Full command path, space-joined from the root (`plan run`). */
	readonly name: string;
	readonly description: string;
	/** commander-computed usage tail, e.g. `[options] <plan-id>`. */
	readonly usage: string;
	readonly arguments: readonly CommandArgument[];
	readonly options: readonly CommandOption[];
	/** True for pure grouping commands (`plan`, `config`, `db`). */
	readonly isGroup: boolean;
}

/** Walk a commander program into the flat, full-path command reference. */
export function collectCommandReference(program: Command): CommandEntry[] {
	const out: CommandEntry[] = [];
	const walk = (cmd: Command, prefix: string): void => {
		for (const child of cmd.commands) {
			const name = prefix === "" ? child.name() : `${prefix} ${child.name()}`;
			out.push({
				name,
				description: child.description(),
				usage: child.usage(),
				arguments: child.registeredArguments.map(toArgument),
				options: child.options.map(toOption),
				isGroup: child.commands.length > 0,
			});
			walk(child, name);
		}
	};
	walk(program, "");
	return out;
}

/** The flags declared on the program itself (`--output`, `--version`). */
export function collectGlobalOptions(program: Command): CommandOption[] {
	return program.options.map(toOption);
}

function toArgument(arg: Argument): CommandArgument {
	return {
		name: arg.name(),
		required: arg.required,
		variadic: arg.variadic,
		description: arg.description,
	};
}

function toOption(opt: Option): CommandOption {
	return {
		flags: opt.flags,
		description: opt.description,
		mandatory: opt.mandatory,
		...(opt.defaultValue !== undefined ? { defaultValue: opt.defaultValue } : {}),
	};
}
