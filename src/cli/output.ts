/**
 * Stdio + spawn seams for the CLI commands.
 *
 * Each command is a pure function of `(context, args) -> Promise<{exitCode}>`,
 * with all observable side effects flowing through the seams declared here.
 * Production callers wire `process.stdout` / `process.stderr` / `process.env`;
 * tests pass capture-buffers and synthetic env tables.
 */

import { WarrenClientError, WarrenUnreachableError } from "../client/errors.ts";
import { ValidationError } from "../core/errors.ts";
import {
	defaultSpawn,
	type SpawnFn as ProjectsSpawnFn,
	type SpawnOptions,
	type SpawnResult,
} from "../projects/clone.ts";
import { authFailureHint } from "./auth-hints.ts";
import type { ClientConfigSource } from "./client.ts";

export interface WriteSink {
	write(chunk: string): void;
}

export interface Stdio {
	readonly stdout: WriteSink;
	readonly stderr: WriteSink;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type CliSpawn = ProjectsSpawnFn;
export type { SpawnOptions, SpawnResult };

/**
 * The shared context every CLI command receives. `now` is exposed so tests
 * can pin the clock; the commands forward it onto repos / spawnRun / reap.
 */
export interface CliContext {
	readonly env: EnvLike;
	readonly stdio: Stdio;
	readonly spawn: CliSpawn;
	readonly now?: () => Date;
	/**
	 * Resolved global `--output` mode (warren-b61e). Optional so existing
	 * tests and internal callers keep compiling; `outputMode()` applies the
	 * `ndjson` default. Production threads the commander global option in
	 * via `buildProgram`.
	 */
	readonly output?: OutputMode;
	/**
	 * Which slot supplied the token this invocation carries (warren-2d4c):
	 * the `--token` flag, the environment, the client config file, or
	 * nothing at all. `resolveCommandClient` puts it here, so
	 * {@link commandFailure} can name the rejected credential's slot
	 * instead of guessing from the environment. Optional because the
	 * genuinely-local commands (`serve`, `db migrate-to-postgres`,
	 * `doctor --local`) resolve no client, and tests build contexts by hand.
	 */
	readonly tokenSource?: ClientConfigSource;
}

/** A stdout-shaped sink backed by Node's writable streams (for production). */
export const PROCESS_STDIO: Stdio = {
	stdout: {
		write: (chunk) => {
			process.stdout.write(chunk);
		},
	},
	stderr: {
		write: (chunk) => {
			process.stderr.write(chunk);
		},
	},
};

/**
 * The production `Bun.spawn` adaptor, re-exported so CLI commands keep
 * importing their seams from one module.
 */
export { defaultSpawn };

/** Print one JSON object per line ('\n' terminator) to a sink. */
export function writeJsonLine(sink: WriteSink, value: unknown): void {
	sink.write(`${JSON.stringify(value)}\n`);
}

/* -------------------------------------------------------------------------
 * Agent-facing output contract (warren-b61e, pl-882c step 10).
 *
 * Agents are the primary CLI consumer, so machine-readable output is the
 * DEFAULT and human output is the opt-in:
 *
 *   ndjson  one JSON object per line, event-tagged (writeJsonLine) — default
 *   json    a single final JSON document for one-shot commands
 *   pretty  human-readable rendering (tables, glyphs, D6 durations)
 *
 * Errors always go to stderr as `[code] message` + optional hint
 * (formatError); stdout stays machine-parseable in ndjson/json modes.
 * ------------------------------------------------------------------------- */

/** The global `--output` flag values, in help-text order. */
export const OUTPUT_MODES = ["ndjson", "json", "pretty"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** The default output mode when `--output` is not passed: NDJSON. */
export const DEFAULT_OUTPUT_MODE: OutputMode = "ndjson";

/**
 * Coerce a `--output` flag value to an {@link OutputMode}. Returns null for
 * an unrecognised value so the caller can raise a usage error (exit 2).
 * `undefined` resolves to the default rather than null.
 */
export function parseOutputMode(value: string | undefined): OutputMode | null {
	if (value === undefined) return DEFAULT_OUTPUT_MODE;
	return (OUTPUT_MODES as readonly string[]).includes(value) ? (value as OutputMode) : null;
}

/** The context's resolved output mode (defaults to `ndjson`). */
export function outputMode(context: CliContext): OutputMode {
	return context.output ?? DEFAULT_OUTPUT_MODE;
}

/**
 * Emit a one-shot command result on stdout per the output contract:
 * ndjson → one compact line, json → one indented document, pretty → the
 * supplied human line (falling back to the indented document when the
 * command has no prettier rendering).
 */
export function writeResult(context: CliContext, value: unknown, pretty?: string): void {
	const mode = outputMode(context);
	if (mode === "ndjson") {
		writeJsonLine(context.stdio.stdout, value);
		return;
	}
	if (mode === "pretty" && pretty !== undefined) {
		context.stdio.stdout.write(`${pretty}\n`);
		return;
	}
	context.stdio.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/* -------------------------------------------------------------------------
 * Stable exit codes (warren-b61e). This table is the single source of
 * truth: the CLI help epilogue renders it, the generated CLI reference
 * (warren-1caf) consumes the EXIT_CODE_TABLE export, and tests assert the
 * numbers never drift.
 * ------------------------------------------------------------------------- */

export const EXIT_SUCCESS = 0;
export const EXIT_RUN_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_SERVER_UNREACHABLE = 3;
export const EXIT_AUTH_REJECTED = 4;
export const EXIT_SIGINT_DETACH = 130;

export interface ExitCodeRow {
	readonly code: number;
	readonly name: string;
	readonly summary: string;
}

/** The documented exit-code table, in ascending order. */
export const EXIT_CODE_TABLE: readonly ExitCodeRow[] = [
	{ code: EXIT_SUCCESS, name: "success", summary: "the command completed successfully" },
	{
		code: EXIT_RUN_FAILED,
		name: "run-failed",
		summary:
			"the dispatched run/plan-run reached a non-success terminal state, or the command failed for any other reason",
	},
	{
		code: EXIT_USAGE,
		name: "usage-error",
		summary:
			"bad flags or arguments (missing required option, invalid --output value, validation error)",
	},
	{
		code: EXIT_SERVER_UNREACHABLE,
		name: "server-unreachable",
		summary: "the warren server did not answer the pre-flight probe",
	},
	{
		code: EXIT_AUTH_REJECTED,
		name: "auth-rejected",
		summary: "the server rejected the bearer token (HTTP 401/403)",
	},
	{
		code: EXIT_SIGINT_DETACH,
		name: "sigint-detach",
		summary: "operator detached a live event tail with SIGINT; the remote run keeps going",
	},
];

/** Render the exit-code table as aligned plain-text lines (help epilogue). */
export function formatExitCodeTable(): string {
	const width = Math.max(...EXIT_CODE_TABLE.map((row) => String(row.code).length));
	return EXIT_CODE_TABLE.map(
		(row) => `  ${String(row.code).padStart(width)}  ${row.name} — ${row.summary}`,
	).join("\n");
}

/**
 * Map a thrown error to the stable exit-code table: unreachable server → 3,
 * auth rejection (401/403) → 4, validation → 2, anything else → 1.
 */
export function exitCodeForError(err: unknown): number {
	if (err instanceof WarrenUnreachableError) return EXIT_SERVER_UNREACHABLE;
	if (err instanceof WarrenClientError && (err.status === 401 || err.status === 403)) {
		return EXIT_AUTH_REJECTED;
	}
	if (err instanceof ValidationError) return EXIT_USAGE;
	return EXIT_RUN_FAILED;
}

/**
 * D6 duration rendering: `4.2s` / `3.1m` / `1.4h`, one decimal place, the
 * unit chosen by magnitude. Shared by every pretty-mode duration so the
 * CLI speaks one duration dialect.
 */
export function formatDurationMs(ms: number): string {
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The standard catch-tail for command runners: report the error on stderr
 * and map it to the stable exit-code table ({@link exitCodeForError}).
 * Extracted in warren-00df — `init` and `config-migrate` carried identical
 * copies grandfathered in the dups allowlist.
 */
export function commandFailure(context: CliContext, err: unknown): { readonly exitCode: number } {
	context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
	// warren-2d4c: name the slot the rejected credential came from. The
	// source rides on the context (`resolveCommandClient` resolved it
	// alongside the client), so a rejected `--token` is no longer blamed on
	// a WARREN_API_TOKEN that merely happened to be set. `warren doctor`
	// reads the same helper, so neither surface can word it differently.
	if (exitCodeForError(err) === EXIT_AUTH_REJECTED) {
		context.stdio.stderr.write(`  hint: ${authFailureHint(context.tokenSource, context.env)}\n`);
	}
	return { exitCode: exitCodeForError(err) };
}

/** Format a thrown error for human stderr output. */
export function formatError(err: unknown): string {
	if (err instanceof Error) {
		const code = (err as Error & { code?: unknown }).code;
		const codeStr = typeof code === "string" ? `[${code}] ` : "";
		const hint = (err as Error & { recoveryHint?: unknown }).recoveryHint;
		const hintStr = typeof hint === "string" ? `\n  hint: ${hint}` : "";
		return `${codeStr}${err.message}${hintStr}`;
	}
	return String(err);
}
