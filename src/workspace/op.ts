/**
 * 1Password (`op://`) secret resolver.
 *
 * `op://<vault>/<item>/<field>` references in a project's `[secrets]` block are
 * resolved by shelling out to the 1Password CLI (`op`). The `op` binary is
 * optional — if it's missing, we fail with a clear `SecretResolutionError`
 * pointing at the offending key.
 *
 * Two seams are exposed for testing:
 *   - `runOpRead`: the spawn wrapper. Default implementation calls
 *     `op read <ref>`; tests override with a fake.
 *   - `OpResolver` class: holds a small in-process cache so repeated refs
 *     in the same `[secrets]` block don't fan out to N `op` processes.
 *
 * Extracted verbatim (behavior-identical) from burrow's `src/secrets/op.ts`
 * into warren's workspace cluster; the only change is the error class, which now
 * comes from `src/workspace/errors.ts` (see `docs/design/k8s-migration-plan.md`
 * §5.A). No burrow-repo imports.
 */

import { SecretResolutionError } from "./errors.ts";

export const OP_PROTOCOL = "op://";

export interface OpReadInput {
	ref: string;
	signal?: AbortSignal;
}

export interface OpReadResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type OpReadFn = (input: OpReadInput) => Promise<OpReadResult>;

/**
 * Spawn `op read <ref>` and capture stdout. Resolver always strips a trailing
 * newline (`op` always emits one), so this returns raw output as-is.
 */
export const defaultOpRead: OpReadFn = async ({ ref, signal }) => {
	const proc = Bun.spawn(["op", "read", ref], {
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
};

export interface OpResolverOptions {
	read?: OpReadFn;
	cache?: Map<string, string>;
}

export class OpResolver {
	private readonly read: OpReadFn;
	private readonly cache: Map<string, string>;

	constructor(opts: OpResolverOptions = {}) {
		this.read = opts.read ?? defaultOpRead;
		this.cache = opts.cache ?? new Map();
	}

	static isOpRef(value: string): boolean {
		return value.startsWith(OP_PROTOCOL);
	}

	/**
	 * Resolve a single op:// reference. Throws SecretResolutionError on a
	 * non-zero exit, missing `op` binary (ENOENT), or empty output.
	 */
	async resolve(envKey: string, ref: string): Promise<string> {
		if (!OpResolver.isOpRef(ref)) {
			throw new SecretResolutionError(
				`secret ${envKey} expected an op:// reference, got '${ref}'`,
				{
					recoveryHint:
						"use op://<vault>/<item>/<field> or remove the entry to fall back to literal/env",
				},
			);
		}
		const cached = this.cache.get(ref);
		if (cached !== undefined) return cached;
		let res: OpReadResult;
		try {
			res = await this.read({ ref });
		} catch (err) {
			if (isMissingOpBinary(err)) {
				throw new SecretResolutionError(
					`failed to resolve ${envKey} (${ref}): \`op\` CLI not found on PATH`,
					{
						cause: err,
						recoveryHint:
							"install 1Password CLI from https://developer.1password.com/docs/cli/get-started/",
					},
				);
			}
			throw new SecretResolutionError(
				`failed to spawn \`op read\` for ${envKey}: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}
		if (res.exitCode !== 0) {
			throw new SecretResolutionError(
				`op read ${ref} failed for ${envKey} (exit ${res.exitCode})`,
				{
					recoveryHint: res.stderr.trim() || "run `op signin` and verify the reference path",
				},
			);
		}
		const value = stripTrailingNewline(res.stdout);
		if (value.length === 0) {
			throw new SecretResolutionError(`op read ${ref} returned empty output for ${envKey}`, {
				recoveryHint: "verify the field exists in the referenced item",
			});
		}
		this.cache.set(ref, value);
		return value;
	}
}

function stripTrailingNewline(s: string): string {
	if (s.endsWith("\r\n")) return s.slice(0, -2);
	if (s.endsWith("\n")) return s.slice(0, -1);
	return s;
}

function isMissingOpBinary(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: unknown }).code;
	if (code === "ENOENT") return true;
	const msg = err instanceof Error ? err.message : "";
	return /executable not found|ENOENT/i.test(msg);
}
