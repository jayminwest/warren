/**
 * Acceptance harness entry — `bun run scripts/acceptance/run.ts`.
 *
 * Phase 14 (warren-3ee3): exercises the §3.1 V1 acceptance criteria
 * against a real warren+burrow process pair (in-proc by default,
 * docker compose with `--container`).
 *
 * Flags:
 *   --mode in-proc | container       boot mode (default in-proc)
 *   --only <id1,id2,...>             run a subset of scenarios by id
 *   --stop-on-failure                exit on first failure
 *   --keep-tmp                       leave the temp dir after run (debug)
 *   --real                           opt into real-LLM scenarios that
 *                                    require ANTHROPIC_API_KEY (deferred —
 *                                    today this is a no-op; ACCEPTANCE.md
 *                                    runbook covers the manual gate)
 *
 * Exit code: 0 if all scenarios pass, 1 otherwise.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type BootMode,
	formatOutcomes,
	runScenarios,
	type Scenario,
	type ScenarioCtx,
	type ScenarioLogger,
} from "./lib/assert.ts";
import { type BuiltFixtures, buildFixtures } from "./lib/fixtures.ts";
import { type BootHandle, bootInProc } from "./lib/inproc.ts";

import { scenario as scenario01 } from "./scenarios/01-boot-healthz-readyz.ts";
import { scenario as scenario02 } from "./scenarios/02-agents-refresh.ts";
import { scenario as scenario03 } from "./scenarios/03-projects-management.ts";
import { scenario as scenario04 } from "./scenarios/04-run-spawn.ts";
import { scenario as scenario07 } from "./scenarios/07-steer.ts";
import { scenario as scenario08 } from "./scenarios/08-cancel.ts";

const SCENARIOS: readonly Scenario[] = [
	scenario01,
	scenario02,
	scenario03,
	scenario04,
	scenario07,
	scenario08,
];

interface ParsedArgs {
	readonly mode: BootMode;
	readonly only: ReadonlySet<string> | undefined;
	readonly stopOnFailure: boolean;
	readonly keepTmp: boolean;
	readonly real: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	let mode: BootMode = "in-proc";
	let only: ReadonlySet<string> | undefined;
	let stopOnFailure = false;
	let keepTmp = false;
	let real = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--mode": {
				const next = argv[++i];
				if (next !== "in-proc" && next !== "container") {
					throw new Error(`--mode expects "in-proc" or "container", got ${JSON.stringify(next)}`);
				}
				mode = next;
				break;
			}
			case "--only": {
				const next = argv[++i];
				if (next === undefined) throw new Error("--only requires a comma-separated id list");
				only = new Set(
					next
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s !== ""),
				);
				break;
			}
			case "--stop-on-failure":
				stopOnFailure = true;
				break;
			case "--keep-tmp":
				keepTmp = true;
				break;
			case "--real":
				real = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`unknown flag: ${JSON.stringify(arg)}`);
		}
	}
	return { mode, only, stopOnFailure, keepTmp, real };
}

function printHelp(): void {
	console.log(`Usage: bun run scripts/acceptance/run.ts [options]

Options:
  --mode in-proc|container   boot mode (default: in-proc)
  --only id1,id2,...         run only scenarios with these ids
  --stop-on-failure          exit on the first failing scenario
  --keep-tmp                 leave the temp dir for inspection
  --real                     opt-in to real-LLM scenarios (manual gate)
  -h, --help                 print this message

Set WARREN_ACCEPTANCE_LOG_LEVEL to "info" or "debug" to see warren server
logs; set WARREN_ACCEPTANCE_WARREN_STDOUT=1 / _STDERR=1 / _BURROW_STDOUT=1
to passthrough child-process logs.`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	if (args.mode === "container") {
		console.error("acceptance: --container mode not yet wired (deferred to follow-up).");
		return 2;
	}

	const tmpRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-"));
	const logger = makeLogger();

	logger.info(`acceptance: mode=${args.mode} tmp=${tmpRoot}`);

	const token = randomToken();

	let handle: BootHandle | undefined;
	let fixtures: BuiltFixtures | undefined;
	try {
		fixtures = await buildFixtures({ tmpRoot });
		logger.info(
			`acceptance: fixtures built (canopy=${fixtures.canopyRepoUrl} project=${fixtures.sampleProjectGitUrl})`,
		);
		handle = await bootInProc({
			tmpRoot,
			token,
			canopyRepoUrl: fixtures.canopyRepoUrl,
			gitConfigPath: fixtures.gitConfigPath,
		});
		logger.info(`acceptance: warren ready at ${handle.warrenUrl}`);

		const ctx: ScenarioCtx = {
			mode: args.mode,
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			fixtures: {
				canopyRepoUrl: fixtures.canopyRepoUrl,
				canopyRepoPath: fixtures.canopyRepoPath,
				sampleProjectGitUrl: fixtures.sampleProjectGitUrl,
				sampleProjectName: fixtures.sampleProjectName,
				sampleProjectPath: fixtures.sampleProjectPath,
				stubAgentName: fixtures.stubAgentName,
				knownSeedTitle: fixtures.knownSeedTitle,
				knownMulchDomain: fixtures.knownMulchDomain,
			},
			logger,
			tmp: tmpRoot,
		};

		const { outcomes, exitCode } = await runScenarios(SCENARIOS, ctx, {
			mode: args.mode,
			stopOnFailure: args.stopOnFailure,
			...(args.only !== undefined ? { only: args.only } : {}),
		});

		console.log(formatOutcomes(outcomes));
		return exitCode;
	} catch (err) {
		const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		console.error(`acceptance: harness boot failed:\n${message}`);
		return 1;
	} finally {
		if (handle !== undefined) {
			try {
				if (args.keepTmp) {
					// Stop processes but don't rm-rf the tmp dir.
					await handle.killWarren().catch(() => undefined);
					await handle.killBurrow().catch(() => undefined);
					console.log(`acceptance: kept tmp dir at ${tmpRoot}`);
				} else {
					await handle.stop();
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`acceptance: teardown error: ${message}`);
			}
		}
	}
}

function makeLogger(): ScenarioLogger {
	const verbose = process.env.WARREN_ACCEPTANCE_LOG_LEVEL === "debug";
	return {
		info: (msg) => console.log(`[acceptance] ${msg}`),
		warn: (msg) => console.warn(`[acceptance] ${msg}`),
		debug: (msg) => {
			if (verbose) console.log(`[acceptance:debug] ${msg}`);
		},
	};
}

function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`acceptance: fatal:`, err);
		process.exit(1);
	},
);
