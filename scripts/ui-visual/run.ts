/**
 * `bun run check:ui-visual` (warren-99e1): boot the deterministic fixture
 * (warren-010b), run the Playwright specs against it, tear down, and exit
 * with Playwright's code.
 *
 *   bun run check:ui-visual [--build] [--port N] [playwright test args…]
 *
 * `--build` runs `bun run build:ui` first; without it the built SPA in
 * `src/ui/dist/` must already exist. Every other argument goes through to
 * `bunx playwright test` (`--grep run-detail`, `--headed`, `--ui`,
 * `--update-snapshots`, …). Playwright runs under Node through bunx, never
 * `bun --bun` (oven-sh/bun#8222). Not part of `check:all`: the gate
 * manifest is frozen, and CI runs this from its own workflow.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { bootFixture } from "./fixture-boot.ts";
import { FIXTURE_ENV } from "./fixture-env.ts";
import { goldenGate } from "./golden-cases.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONFIG = join(import.meta.dir, "playwright.config.ts");

export interface RunArgs {
	readonly build: boolean;
	readonly port: number | undefined;
	readonly playwrightArgs: readonly string[];
}

/** Split our own flags from the ones forwarded to `playwright test`. */
export function parseRunArgs(argv: readonly string[]): RunArgs {
	let build = false;
	let port: number | undefined;
	const playwrightArgs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--build") {
			build = true;
		} else if (arg === "--port") {
			const value = Number(argv[i + 1]);
			if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
				throw new Error(`--port needs an integer in 1..65535; got '${argv[i + 1] ?? ""}'`);
			}
			port = value;
			i++;
		} else {
			playwrightArgs.push(arg);
		}
	}
	return { build, port, playwrightArgs };
}

async function exec(cmd: string[], env?: Record<string, string>): Promise<number> {
	const proc = Bun.spawn(cmd, {
		cwd: REPO_ROOT,
		stdio: ["inherit", "inherit", "inherit"],
		env: { ...process.env, ...env },
	});
	const forward = (sig: NodeJS.Signals) => (): void => proc.kill(sig);
	const onInt = forward("SIGINT");
	const onTerm = forward("SIGTERM");
	process.on("SIGINT", onInt);
	process.on("SIGTERM", onTerm);
	try {
		return await proc.exited;
	} finally {
		process.off("SIGINT", onInt);
		process.off("SIGTERM", onTerm);
	}
}

async function main(argv: readonly string[]): Promise<number> {
	const args = parseRunArgs(argv);
	if (args.build) {
		const code = await exec(["bun", "run", "build:ui"]);
		if (code !== 0) return code;
	}
	if (!existsSync(join(REPO_ROOT, "src", "ui", "dist", "index.html"))) {
		console.error("ui-visual: src/ui/dist is missing; run `bun run build:ui` or pass --build");
		return 1;
	}
	const gate = goldenGate(process.env, process.platform, process.arch);
	if (!gate.enabled) console.error(`ui-visual: skipping golden.pw.ts: ${gate.reason}`);
	const handle = await bootFixture(args.port !== undefined ? { port: args.port } : {});
	try {
		console.error(`ui-visual: fixture at ${handle.output.baseUrl}`);
		return await exec(["bunx", "playwright", "test", "--config", CONFIG, ...args.playwrightArgs], {
			[FIXTURE_ENV]: JSON.stringify(handle.output),
		});
	} finally {
		await handle.stop();
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
