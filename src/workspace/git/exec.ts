/**
 * Shared `git` subprocess runner used by worktree + identity helpers.
 *
 * Returns stdout/stderr/exitCode rather than throwing on non-zero exits so
 * callers can decide whether a failure is fatal (worktree add) or expected
 * (probing for a host clone). Throwing helpers are layered on top.
 *
 * Extracted verbatim from burrow's `src/git/exec.ts` (k8s-migration §5.A);
 * both repos are Bun, so `Bun.spawn` transplants as-is. The only warren-native
 * change is swapping burrow's `WorkspaceMaterializationError` for warren's own
 * (see `../errors.ts`).
 */

import { WorkspaceMaterializationError } from "../errors.ts";

export interface RunGitOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: string;
	gitBin?: string;
}

export interface RunGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function runGit(args: string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
	const env = filterUndefined(opts.env ?? process.env);
	const proc = Bun.spawn([opts.gitBin ?? "git", ...args], {
		cwd: opts.cwd,
		env,
		stdin: opts.stdin !== undefined ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (opts.stdin !== undefined) {
		const sink = proc.stdin;
		if (sink && typeof sink !== "number") {
			sink.write(new TextEncoder().encode(opts.stdin));
			await sink.end();
		}
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

export async function runGitOrThrow(
	args: string[],
	opts: RunGitOptions = {},
): Promise<RunGitResult> {
	const res = await runGit(args, opts);
	if (res.exitCode !== 0) {
		throw new WorkspaceMaterializationError(
			`git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
			{
				recoveryHint:
					"Run the failing command by hand to see the underlying git error, then retry once it's resolved.",
			},
		);
	}
	return res;
}

function filterUndefined(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}
