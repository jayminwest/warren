/**
 * Acceptance harness entry — `bun run scripts/acceptance/run.ts`.
 *
 * Phase 14 (warren-3ee3): exercises the §3.1 V1 acceptance criteria
 * against a real warren+burrow process pair (in-proc by default,
 * `--mode container` brings up the docker-compose stack and runs the
 * container-supported scenarios on top of it).
 *
 * Flags:
 *   --mode in-proc | container       boot mode (default in-proc)
 *   --only <id1,id2,...>             run a subset of scenarios by id
 *   --stop-on-failure                exit on first failure
 *   --keep-tmp                       leave the temp dir / compose stack after run (debug)
 *   --real                           opt into real-LLM scenarios; today
 *                                    a no-op flag — ACCEPTANCE.md
 *                                    documents the manual gate
 *
 * Exit code: 0 if all scenarios pass, 1 otherwise.
 */
import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
import { bootCompose, type ComposeBootHandle } from "./lib/compose.ts";
import { type BuiltFixtures, buildFixtures } from "./lib/fixtures.ts";
import { type BootHandle, bootInProc } from "./lib/inproc.ts";

import { scenario as scenario01 } from "./scenarios/01-boot-healthz-readyz.ts";
import { scenario as scenario02 } from "./scenarios/02-agents-refresh.ts";
import { scenario as scenario03 } from "./scenarios/03-projects-management.ts";
import { scenario as scenario04 } from "./scenarios/04-run-spawn.ts";
import { scenario as scenario05 } from "./scenarios/05-events-stream.ts";
import { scenario as scenario06 } from "./scenarios/06-restart-recovery.ts";
import { scenario as scenario07 } from "./scenarios/07-steer.ts";
import { scenario as scenario08 } from "./scenarios/08-cancel.ts";
import { scenario as scenario09 } from "./scenarios/09-reap-mulch-roundtrip.ts";
import { scenario as scenario10 } from "./scenarios/10-reap-seeds-roundtrip.ts";
import { scenario as scenario11 } from "./scenarios/11-doctor-exit-codes.ts";
import { scenario as scenario12 } from "./scenarios/12-supervisor-restart-budget.ts";
import { scenario as scenario13 } from "./scenarios/13-container-smoke.ts";
import { scenario as scenario14 } from "./scenarios/14-warren-config.ts";
import { scenario as scenario15 } from "./scenarios/15-triggers-roundtrip.ts";
import { scenario as scenario16 } from "./scenarios/16-pi-parity-smoke.ts";
import { scenario as scenario17 } from "./scenarios/17-init-scaffold.ts";
import { scenario as scenario18 } from "./scenarios/18-multi-worker.ts";
import { scenario as scenario19 } from "./scenarios/19-warren-on-postgres.ts";
import { scenario as scenario20 } from "./scenarios/20-preview.ts";
import { scenario as scenario20Path } from "./scenarios/20-preview-path.ts";
import { scenario as scenario21 } from "./scenarios/21-claude-code-cost-smoke.ts";
import { scenario as scenario22 } from "./scenarios/22-seeds-extensions-roundtrip.ts";
import { scenario as scenario23 } from "./scenarios/23-canopy-project-tier.ts";
import { scenario as scenario24 } from "./scenarios/24-preview-node-runtime.ts";

const SCENARIOS: readonly Scenario[] = [
	scenario01,
	scenario02,
	scenario03,
	scenario04,
	scenario05,
	scenario06,
	scenario07,
	scenario08,
	scenario09,
	scenario10,
	scenario11,
	scenario12,
	scenario13,
	scenario14,
	scenario15,
	scenario16,
	scenario17,
	scenario18,
	scenario19,
	scenario20,
	scenario20Path,
	scenario21,
	scenario22,
	scenario23,
	scenario24,
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
	const tmpRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-"));
	const logger = makeLogger();

	logger.info(`acceptance: mode=${args.mode} tmp=${tmpRoot}`);
	if (args.real) {
		// --real is a documented gate flag (ACCEPTANCE.md §"Manual gates");
		// today the harness has no automated --real scenario, so we surface
		// the no-op explicitly rather than silently dropping it.
		logger.warn(
			"acceptance: --real is a doc-only gate today; see ACCEPTANCE.md for the manual claude-code run.",
		);
	}

	const token = randomToken();

	if (args.mode === "container") {
		return await runContainerMode({ tmpRoot, token, args, logger });
	}
	return await runInProcMode({ tmpRoot, token, args, logger });
}

interface RunModeArgs {
	readonly tmpRoot: string;
	readonly token: string;
	readonly args: ParsedArgs;
	readonly logger: ScenarioLogger;
}

async function runInProcMode(opts: RunModeArgs): Promise<number> {
	const { tmpRoot, token, args, logger } = opts;
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
			extraEnv: {
				// Stub agent reads this; burrow's [env].optional in the sample
				// project's burrow.toml forwards it into the sandbox. 8s gives
				// scenarios 05/06 a steady stream of per-second heartbeat
				// events while leaving room to kill+restart warren mid-run.
				WARREN_STUB_SLEEP_MS: "8000",
				// Scenario 15 drives a live cron + scheduledFor dispatch via
				// the R-06 tick loop; the 60s production default would push
				// the scenario past any reasonable budget. Other scenarios
				// don't configure `.warren/triggers.yaml` or scheduledFor
				// seeds, so the faster tick is a no-op for them (pl-2f15
				// risk #8 mitigation).
				WARREN_SCHEDULER_TICK_MS: "1000",
			},
		});
		logger.info(`acceptance: warren ready at ${handle.warrenUrl}`);

		const bootHandle = handle;
		const ctx: ScenarioCtx = {
			mode: args.mode,
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			socketPath: handle.socketPath,
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
			lifecycle: {
				killWarren: () => bootHandle.killWarren(),
				restartWarren: () => bootHandle.restartWarren(),
				killBurrow: () => bootHandle.killBurrow(),
			},
		};

		const { outcomes, exitCode } = await runScenarios(SCENARIOS, ctx, {
			mode: args.mode,
			stopOnFailure: args.stopOnFailure,
			...(args.only !== undefined ? { only: args.only } : {}),
		});

		console.log(formatOutcomes(outcomes));

		// Teardown guardrail (warren-9f70): no scenario should leave
		// user.name / user.email set on a project clone's local
		// .git/config. If one does, an agent commit in a subsequent
		// production run against the same clone path inherits the stale
		// identity. Fail the run so the offender surfaces in CI.
		const leaks = await collectUserIdentityLeaks(join(handle.dataDir, "projects"));
		if (leaks.length > 0) {
			console.error(
				`acceptance: warren-9f70 guardrail tripped — project clone(s) leaked user identity into .git/config:`,
			);
			for (const leak of leaks) console.error(`  - ${leak}`);
			return exitCode === 0 ? 1 : exitCode;
		}

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

/**
 * Walk `<dataDir>/projects/*\/*\/.git/config` and return a human-readable
 * description of any clone whose local config still has user.name or
 * user.email set after the run. Empty result = clean.
 */
async function collectUserIdentityLeaks(projectsDir: string): Promise<readonly string[]> {
	const leaks: string[] = [];
	let owners: string[];
	try {
		owners = await readdir(projectsDir);
	} catch {
		// No project clones at all — nothing to check. Scenarios that
		// don't POST /projects leave projectsDir empty or missing.
		return leaks;
	}
	for (const owner of owners) {
		let names: string[];
		try {
			names = await readdir(join(projectsDir, owner));
		} catch {
			continue;
		}
		for (const name of names) {
			const configPath = join(projectsDir, owner, name, ".git", "config");
			let body: string;
			try {
				body = await readFile(configPath, "utf8");
			} catch {
				continue;
			}
			const found = findUserKeys(body);
			if (found.length > 0) {
				leaks.push(`${owner}/${name}: ${found.join(", ")} (${configPath})`);
			}
		}
	}
	return leaks;
}

/**
 * Lightweight INI-ish scan for `name`/`email` under the `[user]` section.
 * We don't shell out to `git config --get`: the harness's job is to
 * detect any stale identity, not to rely on git's parser (which would
 * report `user.signingkey` etc. that we don't care about).
 */
function findUserKeys(configBody: string): readonly string[] {
	const lines = configBody.split(/\r?\n/);
	let inUser = false;
	const found: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inUser = /^\[user(\s|\]|$)/.test(line);
			continue;
		}
		if (!inUser) continue;
		const m = line.match(/^(name|email)\s*=/);
		if (m !== null && m[1] !== undefined) found.push(`user.${m[1]}`);
	}
	return found;
}

async function runContainerMode(opts: RunModeArgs): Promise<number> {
	const { tmpRoot, token, args, logger } = opts;
	// Fixtures are host-side and not bind-mounted into the container (see
	// lib/compose.ts header). Container-mode scenarios that need them
	// declare in-proc-only via `modes: [...]` and skip cleanly here. We
	// still hand the harness empty placeholders for ctx.fixtures so the
	// type contract holds.
	let handle: ComposeBootHandle | undefined;
	try {
		logger.info("acceptance: docker compose up (this builds the image on first run)…");
		handle = await bootCompose({
			tmpRoot,
			token,
			repoRoot: process.cwd(),
		});
		logger.info(
			`acceptance: warren ready at ${handle.warrenUrl} (compose project=${handle.projectName} port=${handle.hostPort})`,
		);

		const ctx: ScenarioCtx = {
			mode: args.mode,
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			socketPath: handle.socketPath,
			fixtures: {
				canopyRepoUrl: "",
				canopyRepoPath: "",
				sampleProjectGitUrl: "",
				sampleProjectName: "",
				sampleProjectPath: "",
				stubAgentName: "",
				knownSeedTitle: "",
				knownMulchDomain: "",
			},
			logger,
			tmp: tmpRoot,
			// lifecycle is intentionally undefined in container mode — the
			// supervisor inside the container owns burrow lifecycle and
			// scenarios that need to drive process control are in-proc only.
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
		console.error(`acceptance: container boot failed:\n${message}`);
		return 1;
	} finally {
		if (handle !== undefined) {
			try {
				if (args.keepTmp) {
					console.log(
						`acceptance: --keep-tmp set; leaving compose stack ${handle.projectName} running. Tear down with: docker compose -p ${handle.projectName} down -v`,
					);
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
