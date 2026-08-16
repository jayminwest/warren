/**
 * pi argv rendering — source-lifted from burrow's `src/runtime/pi.ts`
 * (warren-7933, plan pl-3007). Split out of `./pi.ts` for the file-size
 * budget; the behavior is byte-for-byte burrow's, locked by `./pi.test.ts`.
 *
 * Forced argv flags (locked by unit tests):
 *
 *   - `--mode rpc`            — JSONL command/event protocol.
 *   - `--session-dir <path>`  — pin per-run session storage to
 *                               `<workspace>/.pi/sessions`. Pi writes one
 *                               `<ts>_<uuid>.jsonl` file per run there;
 *                               `extractMetadata` reads the most recent
 *                               file's header to recover the session id.
 *   - `--no-extensions`       — pi's `extension_ui_request` is an
 *                               interactive prompt RPC the dispatcher has
 *                               no path to answer; force-disable to avoid
 *                               hangs on auto-discovered extensions
 *                               (workspace `.pi/extensions/`, user
 *                               `~/.pi/extensions/`).
 *   - `--offline`             — disable pi's startup network operations
 *                               (telemetry, update checks, etc.; same as
 *                               `PI_OFFLINE=1`). Without this, pi sits in
 *                               `ep_poll` for 2+ minutes after spawn
 *                               inside bwrap before emitting its first
 *                               RPC event, because those startup calls
 *                               block before pi's stdin reader processes
 *                               the prompt (burrow-029d). Warren runs are
 *                               headless and don't surface update banners,
 *                               so skipping is pure latency win.
 *   - `--provider anthropic`  — pi's CLI default provider is Gemini;
 *                               omitting this would silently bill
 *                               GEMINI_API_KEY against a runtime declared
 *                               for Claude. Hardcoded so the
 *                               `ANTHROPIC_API_KEY` env var actually
 *                               authenticates.
 */

import type { AgentFrontmatter } from "./types.ts";

const PI_BIN = "pi";

/**
 * Model pin for V1. Matches the model used to capture the golden RPC
 * fixtures under `./parsers/__golden__/`, so the runtime's wire shape
 * stays in lockstep with what the parser was validated against. Bump only
 * when the fixtures are regenerated against a new model.
 */
export const PI_DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Per-run session storage root, relative to the workspace. Pi's
 * `--session-dir` flag resolves relative paths against the agent's cwd
 * (the workspace), so a relative value works for both bwrap (where the
 * workspace is remapped to `/workspace`) and sandbox-exec (where the
 * workspace stays at its host path). The host side reads from
 * `<workspacePath>/<PI_SESSION_DIR>` to recover the session id post-spawn.
 */
export const PI_SESSION_DIR = ".pi/sessions";

/**
 * Default provider when `AdapterSpawnContext.frontmatter.provider` is
 * unset. Kept separate from `PI_FORCED_ARGV` because `buildPiArgv`
 * substitutes this slot when an upstream caller supplies a non-empty
 * frontmatter override (burrow-b5b4); the constant continues to express
 * "what pi runs with no override" so the regression-locked argv shape
 * stays intact.
 */
export const PI_DEFAULT_PROVIDER = "anthropic";

/**
 * Locked prefix of plain `pi`'s argv when no frontmatter overrides are in
 * play. This represents the *extensions-disabled* shape baked into the
 * spawn-per-turn runtime — `--no-extensions` is forced here because the
 * dispatcher has no path to answer pi's interactive `extension_ui_request`
 * RPC, so an unanswered prompt would hang the run (see `extensions` option
 * on `buildPiArgv`). The trailing `--model <PI_DEFAULT_MODEL>` pair is
 * appended in `buildSpawnCommand` — split out so the test that enforces
 * flag presence can assert the prefix without coupling to the exact
 * pinned model. When `frontmatter.provider` is non-empty `buildPiArgv`
 * swaps the final `PI_DEFAULT_PROVIDER` slot for the override; otherwise
 * this array is the rendered prefix verbatim.
 */
export const PI_FORCED_ARGV: readonly string[] = [
	PI_BIN,
	"--mode",
	"rpc",
	"--session-dir",
	PI_SESSION_DIR,
	"--no-extensions",
	"--offline",
	"--provider",
	PI_DEFAULT_PROVIDER,
] as const;

/**
 * Sibling of `PI_FORCED_ARGV` with `--no-extensions` elided — the argv
 * shape a stdin-held runtime that can answer `extension_ui_request`
 * envelopes renders (burrow-12ba). Exposed as a constant so tests can
 * assert against the locked prefix without duplicating the flag list.
 * Kept in lockstep with `PI_FORCED_ARGV` modulo the single
 * `--no-extensions` entry.
 */
export const PI_FORCED_ARGV_WITH_EXTENSIONS: readonly string[] = [
	PI_BIN,
	"--mode",
	"rpc",
	"--session-dir",
	PI_SESSION_DIR,
	"--offline",
	"--provider",
	PI_DEFAULT_PROVIDER,
] as const;

/**
 * Options for `buildPiArgv` (burrow-12ba). `extensions` is the
 * runtime-level override; plain pi can also opt in via
 * `frontmatter.pi.extensions`. Default behavior keeps the locked,
 * byte-identical argv shape (see `PI_FORCED_ARGV`).
 */
export interface BuildPiArgvOptions {
	extensions?: boolean;
}

/**
 * Render pi's argv with optional per-run frontmatter overrides (burrow-b5b4).
 * When `frontmatter.provider` is non-empty (after trim) it replaces the
 * default `PI_DEFAULT_PROVIDER` slot in the locked prefix; when unset, the
 * prefix stays bit-for-bit identical to `PI_FORCED_ARGV`. Same story for
 * `--model`: a non-empty `frontmatter.model` substitutes for
 * `PI_DEFAULT_MODEL`.
 *
 * The optional `options.extensions` seam (burrow-12ba) and
 * `frontmatter.pi.extensions` elide `--no-extensions` when the runtime can
 * drive pi's extension UI surface. Plain pi with no `frontmatter.pi` keeps
 * the no-options call site byte-identical to the V1 shape. Additional
 * `frontmatter.pi` entries map to an allowlisted set of pi CLI flags so
 * upstream callers can opt into project trust, tool filters, and explicit
 * resource paths without minting a new runtime for every flag combo.
 * Exported for unit tests.
 */
export function buildPiArgv(
	frontmatter?: AgentFrontmatter,
	options?: BuildPiArgvOptions,
): string[] {
	const piOptions = parsePiFrontmatterOptions(frontmatter?.pi);
	const withExtensions = options?.extensions === true || piOptions.extensions === true;
	const argv: string[] = [PI_BIN, "--mode", "rpc", "--session-dir", PI_SESSION_DIR];
	if (!withExtensions) argv.push("--no-extensions");
	argv.push("--offline");
	if (piOptions.approve === true) argv.push("--approve");
	if (piOptions.noTools === true) argv.push("--no-tools");
	if (piOptions.noBuiltinTools === true) argv.push("--no-builtin-tools");
	appendCommaOption(argv, "--tools", piOptions.tools);
	appendCommaOption(argv, "--exclude-tools", piOptions.excludeTools);
	appendRepeatedOption(argv, "--extension", piOptions.extension);
	appendRepeatedOption(argv, "--skill", piOptions.skill);
	appendRepeatedOption(argv, "--prompt-template", piOptions.promptTemplate);
	appendRepeatedOption(argv, "--theme", piOptions.theme);
	argv.push("--provider", nonEmpty(frontmatter?.provider) ?? PI_DEFAULT_PROVIDER);
	const model = nonEmpty(frontmatter?.model) ?? PI_DEFAULT_MODEL;
	argv.push("--model", model);
	return argv;
}

type ParsedPiFrontmatterOptions = {
	extensions?: boolean;
	approve?: boolean;
	noTools?: boolean;
	noBuiltinTools?: boolean;
	tools: readonly string[];
	excludeTools: readonly string[];
	extension: readonly string[];
	skill: readonly string[];
	promptTemplate: readonly string[];
	theme: readonly string[];
};

function parsePiFrontmatterOptions(input: unknown): ParsedPiFrontmatterOptions {
	const obj: Record<string, unknown> =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	return {
		extensions: readBooleanOption(obj.extensions),
		approve: readBooleanOption(obj.approve),
		noTools: readBooleanOption(obj.noTools),
		noBuiltinTools: readBooleanOption(obj.noBuiltinTools),
		tools: readStringListOption(obj.tools),
		excludeTools: readStringListOption(obj.excludeTools),
		extension: readStringListOption(obj.extension),
		skill: readStringListOption(obj.skill),
		promptTemplate: readStringListOption(obj.promptTemplate),
		theme: readStringListOption(obj.theme),
	};
}

function readBooleanOption(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readStringListOption(value: unknown): readonly string[] {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function appendCommaOption(argv: string[], flag: string, values: readonly string[]): void {
	if (values.length === 0) return;
	argv.push(flag, values.join(","));
}

function appendRepeatedOption(argv: string[], flag: string, values: readonly string[]): void {
	for (const value of values) argv.push(flag, value);
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
