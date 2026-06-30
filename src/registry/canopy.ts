/**
 * `CanopyClient` — shell-out facade for the `cn` CLI.
 *
 * Warren's only seam to canopy is the `cn` binary; we never import
 * canopy as a library. Two reasons: canopy is git-native and works on
 * an on-disk `.canopy/` directory, and the same canopy CLI is the
 * supported contract for every other os-eco tool, so changes stay
 * visible at one boundary.
 *
 * The facade exposes two operations the registry refresh needs:
 *   - `listAgents()` — `cn list --tag agent --json`, returning prompt
 *     summaries warren cares about (name + version + status).
 *   - `renderAgent(name)` — `cn render <name> --format json`, returning
 *     the raw JSON envelope which `parseRenderedAgent` then validates.
 *
 * What the facade adds beyond a raw `Bun.spawn`:
 *   - Cwd is parameterized so the same facade drives both the library
 *     clone (`forLibrary`) and per-project `.canopy/` directories
 *     (`forProjectPath`, R-03 / pl-fef5). Callers should reach for a
 *     factory rather than picking a cwd by hand.
 *   - Transport-layer failures (binary missing, non-zero exit, malformed
 *     JSON, empty stdout) become `CanopyUnavailableError`, mirroring the
 *     burrow-client transport-error mapping pattern.
 *   - Spawn is injectable so tests can stub `cn` without a real binary on PATH.
 *
 * What the facade deliberately does not do:
 *   - No retry. Same posture as burrow-client: registry refresh is operator-
 *     triggered, not request-driven, so explicit failure is more useful than
 *     hidden retry.
 *   - No semantic validation. That lives in `schema.ts` and is applied by
 *     `refresh.ts`, so a malformed prompt only kills its own row, not the
 *     whole refresh.
 */

import { z } from "zod";
import { formatError } from "../core/errors.ts";
import type { CanopyRegistryConfig } from "./config.ts";
import { CanopyUnavailableError } from "./errors.ts";

export interface SpawnResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface SpawnOptions {
	readonly cwd: string;
	readonly timeoutMs?: number;
}

export type SpawnFn = (cmd: readonly string[], opts: SpawnOptions) => Promise<SpawnResult>;

export const DEFAULT_CANOPY_TIMEOUT_MS = 30_000;

const AgentSummarySchema = z.object({
	name: z.string().min(1),
	version: z.number().int().positive(),
	status: z.enum(["draft", "active", "archived"]).optional(),
	tags: z.array(z.string()).optional(),
});

export type AgentSummary = z.infer<typeof AgentSummarySchema>;

const ListResponseSchema = z.object({
	success: z.literal(true),
	command: z.literal("list"),
	prompts: z.array(AgentSummarySchema.passthrough()),
});

const ErrorResponseSchema = z.object({
	success: z.literal(false),
	command: z.string().optional(),
	error: z.string(),
});

const RawSectionSchema = z.object({
	name: z.string().min(1),
	body: z.string(),
});

const ShowPromptSchema = z.object({
	name: z.string().min(1),
	version: z.number().int().positive(),
	sections: z.array(RawSectionSchema).default([]),
	extends: z.string().min(1).optional(),
	mixins: z.array(z.string().min(1)).optional(),
	frontmatter: z.record(z.string(), z.unknown()).optional(),
	status: z.enum(["draft", "active", "archived"]).optional(),
});

const ShowResponseSchema = z.object({
	success: z.literal(true),
	command: z.literal("show"),
	prompt: ShowPromptSchema.passthrough(),
});

/**
 * Raw, *un-resolved* prompt as returned by `cn show <name> --json` —
 * sections and frontmatter are the prompt's own (no inheritance applied),
 * and `extends` / `mixins` carry the parent references warren composes
 * across tiers in `compose.ts` (warren-44a3 follow-up to R-03 / pl-fef5).
 */
export interface RawAgentPrompt {
	readonly name: string;
	readonly version: number;
	readonly sections: ReadonlyArray<{ readonly name: string; readonly body: string }>;
	readonly extends: string | undefined;
	readonly mixins: ReadonlyArray<string>;
	readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface CanopyClientOptions {
	readonly cnBinary: string;
	readonly cwd: string;
	readonly spawn?: SpawnFn;
	readonly timeoutMs?: number;
}

export interface CanopyClientLibraryOptions {
	readonly config: CanopyRegistryConfig;
	readonly spawn?: SpawnFn;
	readonly timeoutMs?: number;
}

export interface CanopyClientProjectOptions {
	/**
	 * Project root directory. `cn` resolves `.canopy/` relative to its
	 * cwd, so passing the project root (not `<projectPath>/.canopy`)
	 * mirrors how the library clone is wired in `forLibrary`.
	 */
	readonly projectPath: string;
	readonly cnBinary?: string;
	readonly spawn?: SpawnFn;
	readonly timeoutMs?: number;
}

export class CanopyClient {
	private readonly cnBinary: string;
	private readonly cwd: string;
	private readonly spawn: SpawnFn;
	private readonly timeoutMs: number;

	constructor(opts: CanopyClientOptions) {
		this.cnBinary = opts.cnBinary;
		this.cwd = opts.cwd;
		this.spawn = opts.spawn ?? defaultSpawn;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_CANOPY_TIMEOUT_MS;
	}

	/**
	 * Library tier: scan the cloned canopy repo at `config.localDir`.
	 * Existing `POST /agents/refresh` and `warren register-agent` paths
	 * use this factory.
	 */
	static forLibrary(opts: CanopyClientLibraryOptions): CanopyClient {
		return new CanopyClient({
			cnBinary: opts.config.cnBinary,
			cwd: opts.config.localDir,
			...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
	}

	/**
	 * Project tier (R-03 / pl-fef5): scan `<projectPath>/.canopy/` for
	 * project-scoped agents. The `cn` binary name defaults to "cn"
	 * because project-tier refresh is independent of the library env
	 * (`WARREN_CN_BINARY` still applies if the operator overrode it,
	 * but the caller wires that through explicitly).
	 */
	static forProjectPath(opts: CanopyClientProjectOptions): CanopyClient {
		return new CanopyClient({
			cnBinary: opts.cnBinary ?? "cn",
			cwd: opts.projectPath,
			...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
	}

	/** List prompts tagged `agent`, filtered to active status. */
	async listAgents(): Promise<AgentSummary[]> {
		const result = await this.invoke(["list", "--tag", "agent", "--json"]);
		const parsed = parseEnvelope(result, ListResponseSchema, "cn list");
		return parsed.prompts.filter((p) => p.status === undefined || p.status === "active");
	}

	/**
	 * Fetch a prompt's *un-resolved* record by name. Unlike `renderAgent`,
	 * this returns the prompt's own sections + extends/mixins references
	 * without canopy applying inheritance — the warren-side composer
	 * (`compose.ts`) uses it to walk parent chains across tiers
	 * (warren-44a3 follow-up to R-03 / pl-fef5).
	 *
	 * Returns `null` when canopy reports the prompt isn't present at this
	 * client's cwd (structured `{success:false, error:"Prompt 'X' not found"}`
	 * envelope). All other failure modes — transport error, unparseable
	 * envelope, non-zero exit without a structured "not found" — throw
	 * `CanopyUnavailableError` so the compose resolver can distinguish
	 * "look in another tier" from "abort the refresh".
	 */
	async showAgent(name: string): Promise<RawAgentPrompt | null> {
		const result = await this.invoke(["show", name, "--json"]);
		const peek = tryParseJson(result.stdout);
		if (peek !== undefined) {
			const errResp = ErrorResponseSchema.safeParse(peek);
			if (errResp.success) {
				if (isPromptNotFoundMessage(errResp.data.error)) return null;
				throw new CanopyUnavailableError(`cn show ${name} failed: ${errResp.data.error}`, {
					recoveryHint: "verify the canopy store is readable at the client's cwd",
				});
			}
		}
		if (result.exitCode !== 0) {
			throw new CanopyUnavailableError(
				`cn show ${name} exited ${result.exitCode}: ${formatStderr(result)}`,
			);
		}
		if (peek === undefined) {
			throw new CanopyUnavailableError(`cn show ${name} did not produce parseable JSON`, {
				recoveryHint: "ensure the canopy CLI is at version 0.2 or newer (--json envelope)",
			});
		}
		const parsed = ShowResponseSchema.safeParse(peek);
		if (!parsed.success) {
			throw new CanopyUnavailableError(
				`cn show ${name} returned an unrecognized envelope: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
			);
		}
		const prompt = parsed.data.prompt;
		return {
			name: prompt.name,
			version: prompt.version,
			sections: prompt.sections,
			extends: prompt.extends,
			mixins: prompt.mixins ?? [],
			frontmatter: prompt.frontmatter ?? {},
		};
	}

	/** Render a single prompt by name, returning the raw JSON envelope. */
	async renderAgent(name: string): Promise<unknown> {
		// Use the global `--json` flag, not `cn render --format json`. The
		// former emits canopy's full `{success, command, ...}` envelope (so
		// `success: false` errors round-trip cleanly); the latter emits a
		// bare object without `success`/`command`, which makes auth-vs-failure
		// disambiguation lossy.
		const result = await this.invoke(["render", name, "--json"]);
		// Best-effort extraction of canopy's structured `{success: false, error}` envelope
		// so warren reports e.g. "Prompt not found" instead of a raw JSON parse failure.
		const peek = tryParseJson(result.stdout);
		if (peek !== undefined) {
			const errResp = ErrorResponseSchema.safeParse(peek);
			if (errResp.success) {
				throw new CanopyUnavailableError(`cn render ${name} failed: ${errResp.data.error}`, {
					recoveryHint: "verify the prompt exists in the canopy repo (`cn list`)",
				});
			}
		}
		if (result.exitCode !== 0) {
			throw new CanopyUnavailableError(
				`cn render ${name} exited ${result.exitCode}: ${formatStderr(result)}`,
			);
		}
		if (peek === undefined) {
			throw new CanopyUnavailableError(`cn render ${name} did not produce parseable JSON`, {
				recoveryHint: "ensure the canopy CLI is at version 0.2 or newer (--format json)",
			});
		}
		return peek;
	}

	private async invoke(args: readonly string[]): Promise<SpawnResult> {
		const cmd = [this.cnBinary, ...args];
		try {
			return await this.spawn(cmd, { cwd: this.cwd, timeoutMs: this.timeoutMs });
		} catch (err) {
			if (err instanceof CanopyUnavailableError) throw err;
			throw new CanopyUnavailableError(
				`failed to spawn ${this.cnBinary} ${args.join(" ")}: ${formatError(err)}`,
				{
					cause: err,
					recoveryHint: `ensure the ${this.cnBinary} binary is on PATH and the .canopy/ store exists at ${this.cwd}`,
				},
			);
		}
	}
}

function parseEnvelope<T>(result: SpawnResult, schema: z.ZodType<T>, context: string): T {
	if (result.exitCode !== 0) {
		throw new CanopyUnavailableError(
			`${context} exited ${result.exitCode}: ${formatStderr(result)}`,
		);
	}
	const parsed = tryParseJson(result.stdout);
	if (parsed === undefined) {
		throw new CanopyUnavailableError(
			`${context} produced unparseable stdout: ${truncate(result.stdout, 200)}`,
		);
	}
	const validated = schema.safeParse(parsed);
	if (!validated.success) {
		throw new CanopyUnavailableError(
			`${context} returned an unrecognized envelope: ${validated.error.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return validated.data;
}

/**
 * Match canopy's two equivalent "prompt missing" error strings:
 *   - `Prompt 'X' not found`             (cn show)
 *   - `Prompt "X" not found`             (cn render — quoted differently)
 * Used by `showAgent` to collapse the structured-not-found case into a
 * null return so the compose resolver can fall through to other tiers.
 */
function isPromptNotFoundMessage(message: string): boolean {
	return /^Prompt ['"][^'"]+['"] not found$/.test(message.trim());
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return truncate(trimmed, 500);
	const stdout = result.stdout.trim();
	if (stdout !== "") return truncate(stdout, 500);
	return "<no stderr>";
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}

const defaultSpawn: SpawnFn = async (cmd, opts) => {
	if (cmd.length === 0) {
		throw new CanopyUnavailableError("spawn called with empty command");
	}
	const proc = Bun.spawn({
		cmd: cmd as string[],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const ctrl = new AbortController();
	const timer =
		opts.timeoutMs !== undefined
			? setTimeout(() => {
					proc.kill("SIGKILL");
					ctrl.abort();
				}, opts.timeoutMs)
			: undefined;
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (ctrl.signal.aborted) {
			throw new CanopyUnavailableError(
				`command timed out after ${opts.timeoutMs}ms: ${cmd.join(" ")}`,
			);
		}
		return { stdout, stderr, exitCode };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};
