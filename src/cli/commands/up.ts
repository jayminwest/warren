/**
 * `warren up` — the casual-user boot command (warren-c18a, pl-26f3 step 2).
 *
 * One command takes a fresh machine from installed-CLI to a running warren
 * instance with the operator already logged in:
 *
 *   1. Detect the runtime: darwin → local (sandbox-exec); linux with bwrap
 *      on PATH → local (bwrap); otherwise, when a docker daemon looks
 *      reachable, print the compose guidance and exit 0 (no docker
 *      orchestration here); otherwise exit non-zero naming what is missing.
 *      An explicit WARREN_RUNTIME is never overridden.
 *   2. Default WARREN_DATA_DIR to ~/.warren/data (created 0700) when unset;
 *      an explicit env value is left alone.
 *   3. Boot the server in-process exactly as `warren serve` does, by
 *      delegating to `runServe` (serve.ts holds the one sanctioned
 *      CLI→server import; `up` never adds a second exception).
 *   4. After boot, persist base URL + operator token to the client config
 *      via the `warren login` persistence function (mode 0600) so the user
 *      never greps a log for the minted token.
 *
 * Scope guard (pl-26f3): the two stages live here, in order. The
 * credential wizard (warren-80e9) runs first, before boot. The browser
 * handoff (warren-48f8) runs after boot: the server arms the one-time
 * setup code and this command opens the browser at the redemption URL
 * (open(1) / xdg-open), suppressed by --no-open or a non-TTY stdout; the
 * URL is always printed as the fallback.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Command } from "commander";
import type { EnvLike } from "../../client/config.ts";
import { saveWarrenClientConfigToFile } from "../../client/config-file.ts";
import type { WarrenClientConfig } from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { commandFailure } from "../output.ts";
import { runServe, type ServeDeps } from "./serve.ts";
import { defaultUpWizardDeps, mergeUnderEnv, runUpWizard, type UpWizardDeps } from "./up-wizard.ts";

export interface UpArgs {
	/** `--no-open` — do not open the browser at the setup URL (warren-48f8). */
	readonly open?: boolean;
	/**
	 * `--no-wizard` — skip the credential wizard (warren-80e9). Also
	 * automatic when stdin is not a TTY (CI, scripts): prompts never
	 * block, the stored `~/.warren/env` still loads under the real env.
	 */
	readonly wizard?: boolean;
}

/** Platform/binary seams the runtime detection reads. */
export interface UpRuntimeProbe {
	readonly platform: NodeJS.Platform;
	/** Is a binary resolvable on PATH? (sandbox-exec / bwrap) */
	readonly hasBinary: (name: string) => boolean;
	/** Best-effort "is a docker daemon reachable" heuristic. */
	readonly dockerDaemonReachable: () => boolean;
}

export interface UpDeps {
	/** Runtime detection seams; defaults probe the live machine. */
	readonly probe?: UpRuntimeProbe;
	/** Injected for tests; production delegates to the real serve path. */
	readonly serveDeps?: ServeDeps;
	/** Client-config persistence (the `warren login` function). */
	readonly saveConfig?: (config: WarrenClientConfig, env: EnvLike) => string;
	/** Data-dir creation (tests script failure). */
	readonly mkdir?: (path: string) => void;
	readonly homeDir?: () => string;
	/** warren-48f8: is stdout a TTY? Defaults to the live process check. */
	readonly isTty?: () => boolean;
	/** warren-48f8: open `url` in the platform browser (tests record the call). */
	readonly openBrowser?: (url: string) => void;
	/** Credential wizard seams; defaults probe the live machine (warren-80e9). */
	readonly wizard?: UpWizardDeps;
}

export interface UpResult {
	readonly exitCode: number;
	readonly url?: string;
}

/** What runtime detection decided. */
export type UpRuntimeDecision =
	| { readonly choice: "boot"; readonly runtime?: string; readonly sentence: string }
	| { readonly choice: "docker-guidance" }
	| { readonly choice: "fail"; readonly message: string };

/**
 * Detect the runtime for `warren up`. An explicit WARREN_RUNTIME always
 * wins (never overridden — a typo still reaches boot's loud validation).
 * darwin with sandbox-exec and linux with bwrap pick the local provider;
 * anything else falls to the docker-daemon check.
 */
export function detectUpRuntime(env: EnvLike, probe: UpRuntimeProbe): UpRuntimeDecision {
	const explicit = env.WARREN_RUNTIME?.trim();
	if (explicit !== undefined && explicit !== "") {
		return {
			choice: "boot",
			runtime: explicit,
			sentence: `runtime: ${explicit} (from WARREN_RUNTIME — not overridden)`,
		};
	}
	if (probe.platform === "darwin" && probe.hasBinary("sandbox-exec")) {
		return { choice: "boot", runtime: "local", sentence: "runtime: local (darwin sandbox-exec)" };
	}
	if (probe.platform === "linux" && probe.hasBinary("bwrap")) {
		return { choice: "boot", runtime: "local", sentence: "runtime: local (linux bwrap)" };
	}
	if (probe.dockerDaemonReachable()) {
		return { choice: "docker-guidance" };
	}
	const native =
		probe.platform === "darwin"
			? "sandbox-exec"
			: probe.platform === "linux"
				? "bwrap on PATH"
				: "a native sandbox on this platform";
	return {
		choice: "fail",
		message:
			`no usable sandbox (${native}) and no reachable docker daemon — ` +
			"install the sandbox tool or start docker, then re-run `warren up`",
	};
}

/** Default WARREN_DATA_DIR for `warren up` when the env leaves it unset. */
export function defaultUpDataDir(home: string): string {
	return join(home, ".warren", "data");
}

/** Does `name` resolve anywhere on PATH? */
export function binaryOnPath(name: string, env: EnvLike = process.env): boolean {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && existsSync(join(dir, name))) return true;
	}
	return false;
}

/**
 * Best-effort "is a docker daemon reachable" heuristic: DOCKER_HOST is set,
 * or the default unix socket exists. Precise enough to choose between
 * guidance and failure; a full `docker info` round-trip would be slower and
 * untestable for what a casual `warren up` needs.
 */
export function dockerDaemonLikelyReachable(env: EnvLike = process.env): boolean {
	const host = env.DOCKER_HOST?.trim();
	if (host !== undefined && host !== "") return true;
	return existsSync("/var/run/docker.sock") || existsSync("/run/docker.sock");
}

/** Which command opens a URL on this platform (best-effort). */
function browserOpener(context: CliContext): (url: string) => void {
	return (url: string) => {
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		// Fire-and-forget: a failed/absent opener must never take the server
		// down — the printed URL is the fallback path.
		void context.spawn([cmd, url], { cwd: process.cwd() }).catch(() => undefined);
	};
}

export async function runUp(context: CliContext, deps: UpDeps, args: UpArgs): Promise<UpResult> {
	const probe: UpRuntimeProbe = deps.probe ?? {
		platform: process.platform,
		hasBinary: (name) => binaryOnPath(name, context.env),
		dockerDaemonReachable: () => dockerDaemonLikelyReachable(context.env),
	};

	const decision = detectUpRuntime(context.env, probe);
	if (decision.choice === "docker-guidance") {
		context.stdio.stdout.write(
			"warren up: no native sandbox on this machine, but a docker daemon looks reachable.\n" +
				"Boot warren with docker compose instead:\n" +
				"  docker compose up -d\n" +
				"then run `warren login --url <server url>` with the operator token from the\n" +
				"server logs (see docker-compose.yml and README.md for the full compose path).\n",
		);
		return { exitCode: 0 };
	}
	if (decision.choice === "fail") {
		context.stdio.stderr.write(`warren up: ${decision.message}\n`);
		return { exitCode: 1 };
	}

	// Data dir: default ~/.warren/data (created 0700) only when unset.
	const env = { ...context.env } as Record<string, string | undefined>;
	if (env.WARREN_DATA_DIR === undefined || env.WARREN_DATA_DIR.trim() === "") {
		const dataDir = defaultUpDataDir((deps.homeDir ?? homedir)());
		try {
			(deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 })))(dataDir);
		} catch (err) {
			return commandFailure(context, err);
		}
		env.WARREN_DATA_DIR = dataDir;
	}
	if (decision.runtime !== undefined) {
		env.WARREN_RUNTIME = decision.runtime;
	}

	const upContext: CliContext = { ...context, env };
	const save =
		deps.saveConfig ??
		((config: WarrenClientConfig, e: EnvLike) => saveWarrenClientConfigToFile(config, e));

	context.stdio.stdout.write(`${decision.sentence}\n`);

	// Credential wizard (warren-80e9): env > stored > prompted. The stored
	// ~/.warren/env loads on every boot; prompts run only when interactive
	// and a needed credential is absent from both env and store.
	const wizardDeps =
		deps.wizard ?? defaultUpWizardDeps(context, context.env, deps.homeDir ?? homedir);
	const storedEnv = await runUpWizard(context, wizardDeps, { wizard: args.wizard !== false });
	Object.assign(env, mergeUnderEnv(env, storedEnv));

	return runServe(
		upContext,
		{
			...deps.serveDeps,
			// warren-c18a: persist the boot's operator token as the client
			// login, exactly as `warren login` would — no log-grep.
			onBooted: async (handle) => {
				if (handle.operatorToken === undefined) return;
				const path = save({ baseUrl: handle.url, token: handle.operatorToken }, env);
				context.stdio.stdout.write(
					`✔ logged in to ${handle.url} (config: ${path}) — warren commands work with no env vars now\n`,
				);
				// warren-48f8: open the one-time setup URL in a browser so the
				// operator's tab lands already-logged-in; always print it as the
				// fallback (a non-TTY stdout or a failed opener still shows it).
				if (handle.setupUrl === undefined) {
					context.stdio.stdout.write(`UI: ${handle.url}\n`);
					return;
				}
				if (args.open === false) {
					context.stdio.stdout.write(`UI (open this to sign in): ${handle.setupUrl}\n`);
					return;
				}
				context.stdio.stdout.write(`UI: ${handle.setupUrl}\n`);
				if ((deps.isTty ?? (() => process.stdout.isTTY ?? false))()) {
					(deps.openBrowser ?? browserOpener(context))(handle.setupUrl);
				}
			},
		},
		{ setupHandoff: true },
	);
}

export function registerUpCommand(program: Command, context: CliContext): void {
	program
		.command("up")
		.description(
			"boot warren for a fresh machine: detect the runtime, default the data dir, serve, and log the operator in",
		)
		.option("--no-open", "do not open the UI in a browser (the setup URL is still printed)")
		.option(
			"--no-wizard",
			"skip the first-boot credential wizard (also automatic when stdin is not a TTY)",
		)
		.action(async (opts: { open?: boolean; wizard?: boolean }) => {
			const result = await runUp(context, {}, { open: opts.open, wizard: opts.wizard });
			process.exit(result.exitCode);
		});
}
