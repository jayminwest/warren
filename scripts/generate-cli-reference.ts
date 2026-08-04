#!/usr/bin/env bun
/**
 * Automated doc-generation: CLI reference extractor (warren-1caf, plan
 * pl-882c step 13).
 *
 * Renders `docs/cli-reference.md` from the live commander program
 * definition (`buildProgram` in `src/cli/main.ts`) via the shared walk in
 * `src/cli/reference.ts` — the same source `warren prime` consumes. The
 * CLI is the last public surface with no generated counterpart;
 * `docs/http-api.md` (gen:docs) and `docs/openapi.yaml` (gen:openapi) are
 * the established pattern this mirrors.
 *
 * Why import the program instead of regex-parsing main.ts: the command
 * surface is assembled at call time across three modules (main.ts,
 * register-run-commands.ts, bootstrap.ts), so text extraction would have
 * to re-implement commander's tree walk. `buildProgram` is side-effect
 * free until a command action fires, so importing it in a script is safe
 * (the prime golden test does the same).
 *
 * Modes:
 *   bun run gen:cli-ref          # write docs/cli-reference.md
 *   bun run gen:cli-ref:check    # exit 1 if docs/cli-reference.md is stale
 *
 * The check mode rides inside the `lint` gate (the check:all manifest is
 * frozen, so a new drift gate cannot take a manifest slot). CI fails when
 * the command definitions change but the doc isn't regenerated. Fix by
 * running `bun run gen:cli-ref` and committing the result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENV_CONTRACT } from "../src/cli/commands/prime.ts";
import { buildProgram } from "../src/cli/main.ts";
import { type CliContext, EXIT_CODE_TABLE } from "../src/cli/output.ts";
import {
	type CommandArgument,
	type CommandEntry,
	type CommandOption,
	collectCommandReference,
	collectGlobalOptions,
} from "../src/cli/reference.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/cli-reference.md");

/** Side-effect-free context: no command action ever fires during the walk. */
function stubContext(): CliContext {
	return {
		env: {},
		stdio: { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

function formatArgument(arg: CommandArgument): string {
	const wrapped = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
	return arg.variadic ? `${wrapped}...` : wrapped;
}

function formatDefault(option: CommandOption): string {
	return option.defaultValue !== undefined ? `\`${JSON.stringify(option.defaultValue)}\`` : "";
}

function renderGlobalOptions(options: readonly CommandOption[]): string[] {
	const lines = ["## Global options", "", "| Flag | Description |", "| --- | --- |"];
	for (const opt of options) {
		lines.push(`| \`${opt.flags}\` | ${escapeCell(opt.description)} |`);
	}
	lines.push(
		"| `-h, --help` | print command help (commander built-in) |",
		"",
		"Every remote-capable command also accepts `--url <url>` / `--token <token>`, " +
			"listed per command below. Resolution precedence everywhere: " +
			"flags > env > client config file > built-in default.",
		"",
	);
	return lines;
}

function renderEnvironment(): string[] {
	const lines = ["## Environment", "", "| Variable | Summary |", "| --- | --- |"];
	for (const env of ENV_CONTRACT) {
		lines.push(`| \`${env.name}\` | ${escapeCell(env.summary)} |`);
	}
	lines.push("");
	return lines;
}

function renderCommand(entry: CommandEntry): string[] {
	const lines = [`### \`warren ${entry.name}\``, ""];
	if (entry.isGroup) lines.push("_Command group — see the subcommands below._", "");
	if (entry.description !== "") lines.push(entry.description, "");
	lines.push(
		"```bash",
		`warren ${entry.name}${entry.usage === "" ? "" : ` ${entry.usage}`}`,
		"```",
		"",
	);
	if (entry.arguments.length > 0) {
		lines.push("| Argument | Required | Description |", "| --- | --- | --- |");
		for (const arg of entry.arguments) {
			const required = arg.required ? "yes" : "";
			lines.push(`| \`${formatArgument(arg)}\` | ${required} | ${escapeCell(arg.description)} |`);
		}
		lines.push("");
	}
	if (entry.options.length > 0) {
		lines.push("| Flag | Required | Default | Description |", "| --- | --- | --- | --- |");
		for (const opt of entry.options) {
			const required = opt.mandatory ? "yes" : "";
			lines.push(
				`| \`${opt.flags}\` | ${required} | ${formatDefault(opt)} | ${escapeCell(opt.description)} |`,
			);
		}
		lines.push("");
	}
	return lines;
}

function renderExitCodes(): string[] {
	const lines = ["## Exit codes", "", "| Code | Name | Summary |", "| --- | --- | --- |"];
	for (const row of EXIT_CODE_TABLE) {
		lines.push(`| \`${row.code}\` | \`${row.name}\` | ${escapeCell(row.summary)} |`);
	}
	lines.push("");
	return lines;
}

export function renderMarkdown(
	globalOptions: readonly CommandOption[],
	commands: readonly CommandEntry[],
): string {
	const sections: string[] = [];
	sections.push("# warren CLI reference");
	sections.push("");
	sections.push(
		"<!-- AUTO-GENERATED by `bun run gen:cli-ref` from the commander program definition in `src/cli/main.ts`. -->",
	);
	sections.push("<!-- Do not edit by hand. CI fails if this file is out of sync. -->");
	sections.push("");
	sections.push(
		"This page enumerates every `warren` command with its arguments, flags, " +
			"and the stable exit-code table. It's derived directly from the commander " +
			"program definition built by [`src/cli/main.ts`](../src/cli/main.ts) — the " +
			"same walk `warren prime` prints at agent session start — so it can't " +
			"drift from the running CLI.",
	);
	sections.push("");
	sections.push(
		"To refresh: `bun run gen:cli-ref`. To check (CI mode): `bun run gen:cli-ref:check`.",
	);
	sections.push("");
	sections.push(`Total commands: **${commands.length}**.`);
	sections.push("");
	sections.push(...renderGlobalOptions(globalOptions));
	sections.push(...renderEnvironment());
	sections.push("## Commands");
	sections.push("");
	for (const entry of commands) {
		sections.push(...renderCommand(entry));
	}
	sections.push(...renderExitCodes());
	return `${sections.join("\n").trimEnd()}\n`;
}

export function generate(): { content: string; commands: CommandEntry[] } {
	const program = buildProgram(stubContext());
	const commands = collectCommandReference(program);
	if (commands.length === 0) {
		throw new Error("Extractor found zero commands — refusing to overwrite docs/cli-reference.md.");
	}
	return { content: renderMarkdown(collectGlobalOptions(program), commands), commands };
}

function readExisting(): string | null {
	try {
		return readFileSync(OUTPUT_PATH, "utf8");
	} catch {
		return null;
	}
}

function main(): void {
	const checkMode = process.argv.includes("--check");
	const { content, commands } = generate();
	const existing = readExisting();

	if (checkMode) {
		if (existing === null) {
			console.error(
				"docs/cli-reference.md is missing. Run `bun run gen:cli-ref` and commit the result.",
			);
			process.exit(1);
		}
		if (existing !== content) {
			console.error("docs/cli-reference.md is stale relative to the CLI command definitions.");
			console.error("Run `bun run gen:cli-ref` and commit the result.");
			process.exit(1);
		}
		console.log(`gen:cli-ref ok (${commands.length} commands).`);
		return;
	}

	writeFileSync(OUTPUT_PATH, content);
	console.log(`Wrote docs/cli-reference.md (${commands.length} commands).`);
}

if (import.meta.main) main();
