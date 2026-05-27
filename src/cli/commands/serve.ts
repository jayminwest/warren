/**
 * `warren serve` — boot the HTTP server and block until SIGINT/SIGTERM.
 *
 * Thin wrapper around `bootServer` (server/main.ts). The supervisor
 * (Phase 12) execs `warren serve` as one of two child processes and
 * forwards signals; this command's only job is to translate the signal
 * into a `handle.stop()` call and exit cleanly.
 *
 * `--no-auth` plumbs through to the boot config: the loopback dev-loop
 * escape hatch (SPEC §11.D). The bind/data env vars are read by
 * `bootServer` itself; nothing to surface here.
 */

import {
	type BootServerOptions,
	bootServer,
	type WarrenServerHandle,
} from "../../server/main/index.ts";
import type { CliContext } from "../output.ts";
import { formatError } from "../output.ts";

export interface ServeArgs {
	readonly noAuth?: boolean;
}

export interface ServeDeps {
	/** Override the boot function (tests). Defaults to the live `bootServer`. */
	readonly boot?: typeof bootServer;
	/**
	 * Wait-for-shutdown signal — resolves when the operator wants the
	 * server to stop. Production wires this to SIGINT/SIGTERM. Tests
	 * resolve it immediately to exercise the cleanup path.
	 */
	readonly waitForShutdown?: () => Promise<void>;
}

export interface ServeResult {
	readonly exitCode: number;
	readonly url?: string;
}

export async function runServe(
	context: CliContext,
	deps: ServeDeps,
	args: ServeArgs,
): Promise<ServeResult> {
	const boot = deps.boot ?? bootServer;
	const waitForShutdown = deps.waitForShutdown ?? defaultWaitForShutdown;

	let handle: WarrenServerHandle;
	try {
		const opts: BootServerOptions = {
			env: context.env,
			...(args.noAuth === true ? { noAuth: true } : {}),
			...(context.now !== undefined ? { now: context.now } : {}),
		};
		handle = await boot(opts);
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	context.stdio.stdout.write(`warren listening at ${handle.url}\n`);

	try {
		await waitForShutdown();
	} catch (err) {
		// Surface but still go through the stop path.
		context.stdio.stderr.write(`warren: shutdown wait threw: ${formatError(err)}\n`);
	}

	try {
		await handle.stop();
	} catch (err) {
		context.stdio.stderr.write(`warren: shutdown error: ${formatError(err)}\n`);
		return { exitCode: 1, url: handle.url };
	}

	return { exitCode: 0, url: handle.url };
}

/**
 * Block until SIGINT or SIGTERM. Resolves on first signal; a second
 * signal forces the process down via `process.exit(130)` so a stuck
 * shutdown doesn't trap the operator.
 */
function defaultWaitForShutdown(): Promise<void> {
	return new Promise((resolve) => {
		let hits = 0;
		const handler = (): void => {
			hits += 1;
			if (hits === 1) {
				resolve();
				return;
			}
			process.exit(130);
		};
		process.on("SIGINT", handler);
		process.on("SIGTERM", handler);
	});
}
