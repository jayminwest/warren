/**
 * `warren run <agent> <project> -p "..."` — one-shot, no UI.
 *
 * Spawns a run via the §4.3 composition flow, opens a stream bridge so
 * events land in the warren events table, and tails them as NDJSON to
 * stdout until the burrow run terminates. When the bridge ends, fetches
 * the burrow run's terminal state, runs `reapRun` to finalize the warren
 * row + roundtrip mulch/seeds, and exits with a code that mirrors the
 * outcome (succeeded → 0, failed/cancelled → 1).
 *
 * Why bridge + tail rather than just `client.http.runs.stream` directly:
 * keeping the events going through the warren bridge means a CLI-driven
 * run lands in the same events table the HTTP UI would read, so an
 * operator can switch surfaces mid-run without losing scrollback. It
 * also ensures the dedup-by-seq logic exercises the same code path as
 * the server.
 *
 * SIGINT during a live run aborts the local tail but does not cancel
 * the burrow run — that's what `warren cancel` (deferred to V2) or the
 * UI does. The CLI prints a hint on first SIGINT, exits on the second.
 */

import { withTransportMapping } from "../../burrow-client/client.ts";
import type { BurrowClient } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunTerminalState } from "../../db/schema.ts";
import {
	type AutoOpenPrConfig,
	type BridgeRunStreamResult,
	bridgeRunStream,
	loadAutoOpenPrConfigFromEnv,
	loadRunBranchPrefixFromEnv,
	RunEventBroker,
	reapRun,
	type SpawnRunResult,
	spawnRun,
	tailRunEvents,
} from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { createLocalSidecarsResolver } from "../../runtime/local/preview/sidecars.ts";
import { resolveRuntimeProvider } from "../../runtime/registry.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../../triggers/index.ts";
import { createWarrenConfigCache, type WarrenConfigCache } from "../../warren-config/index.ts";
import type { CliContext } from "../output.ts";
import { defaultSpawn, formatError, writeJsonLine } from "../output.ts";

export interface RunArgs {
	readonly agent: string;
	readonly project: string;
	readonly prompt: string;
	readonly trigger?: string;
	/**
	 * Optional per-run override of the agent's `frontmatter.provider`. Empty
	 * / whitespace-only values are ignored. Per warren-618b, takes precedence
	 * over `.warren/defaults.json.defaultProvider`, which in turn takes
	 * precedence over the agent's own frontmatter.
	 */
	readonly providerOverride?: string;
	/** Optional per-run override of the agent's `frontmatter.model`. */
	readonly modelOverride?: string;
}

export interface RunDeps {
	readonly repos: Repos;
	/**
	 * The single local burrow client (warren-76c5). Shared by `spawnRun`,
	 * `bridgeRunStream`, `reapRun`, and `fetchBurrowRunState` — multi-worker
	 * pooling was retired with the K8s migration.
	 */
	readonly burrowClient: BurrowClient;
	/**
	 * Resolved runtime provider for the spawn seam (warren-c42c). Optional: when
	 * omitted the command resolves the boot-selected backend via
	 * `resolveRuntimeProvider` (honoring `WARREN_RUNTIME`) over `burrowClient`.
	 * `spawnRun` dispatches through it — the spawn path no longer takes a burrow
	 * client. Tests inject a stub here (or stub `spawn` outright).
	 */
	readonly runtimeProvider?: RuntimeProvider;
	/** Optional broker injection — defaults to a fresh broker per run. */
	readonly broker?: RunEventBroker;
	/** Override the bridge factory (tests). Defaults to the live `bridgeRunStream`. */
	readonly bridge?: typeof bridgeRunStream;
	/** Override the spawn function (tests). Defaults to the live `spawnRun`. */
	readonly spawn?: typeof spawnRun;
	/** Override reap (tests). Defaults to the live `reapRun`. */
	readonly reap?: typeof reapRun;
	/** Override the burrow run state lookup (tests). */
	readonly fetchBurrowRunState?: (burrowRunId: string) => Promise<RunTerminalState>;
	/**
	 * Auto-open-PR config (warren-f6af). Defaults to
	 * `loadAutoOpenPrConfigFromEnv(process.env)`. Tests pass an explicit
	 * `{ enabled: false, ... }` to keep the network out of the surface.
	 */
	readonly autoOpenPr?: AutoOpenPrConfig;
	/**
	 * Per-project `.warren/` config cache (warren-618b). When wired, spawnRun
	 * picks up `defaultProvider` / `defaultModel` from `.warren/defaults.json`
	 * with the precedence operator override > project default > agent
	 * frontmatter. Defaults to a fresh cache so the CLI honors project
	 * defaults the same way the HTTP server does; tests inject their own.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993). Defaults to
	 * `loadRunBranchPrefixFromEnv(process.env)` so the CLI honors
	 * `WARREN_RUN_BRANCH_PREFIX` the same way the HTTP server does. Tests
	 * pass an explicit value (or `null` to force the built-in "burrow"
	 * default).
	 */
	readonly runBranchPrefixDefault?: string | null;
	/**
	 * Seeds-CLI seam (warren-41d5). Forwarded to reap so the auto_plan_run
	 * sub-step validates a new plan's child seeds before dispatching a
	 * plan-run. Defaults to `{ sdBinary: WARREN_SD_BINARY, spawn:
	 * defaultSpawn }` so the CLI matches the HTTP server; tests inject a
	 * stub (or rely on the default, since the one-shot run rarely creates a
	 * plan).
	 */
	readonly seedsCli?: SeedsCliDeps;
}

export interface RunResult {
	readonly exitCode: number;
	readonly runId?: string;
	readonly state?: RunTerminalState;
}

export async function runRun(
	context: CliContext,
	deps: RunDeps,
	args: RunArgs,
): Promise<RunResult> {
	if (args.agent === "" || args.project === "" || args.prompt === "") {
		context.stdio.stderr.write("warren: agent, project, and --prompt are all required\n");
		return { exitCode: 2 };
	}

	const broker = deps.broker ?? new RunEventBroker();
	const spawn = deps.spawn ?? spawnRun;
	const bridge = deps.bridge ?? bridgeRunStream;
	const reap = deps.reap ?? reapRun;
	const autoOpenPr = deps.autoOpenPr ?? loadAutoOpenPrConfigFromEnv();
	const warrenConfigs = deps.warrenConfigs ?? createWarrenConfigCache();
	const runBranchPrefixDefault =
		deps.runBranchPrefixDefault === null
			? undefined
			: (deps.runBranchPrefixDefault ?? loadRunBranchPrefixFromEnv());
	const fetchBurrowRunState =
		deps.fetchBurrowRunState ?? defaultFetchBurrowRunState(deps.burrowClient);
	// Resolve the active runtime provider once (honoring WARREN_RUNTIME) and share
	// it across spawn + the stream bridge (warren-1fce): the bridge streams,
	// polls, and cancels through the provider seam, not a burrow client.
	const runtimeProvider =
		deps.runtimeProvider ?? resolveRuntimeProvider({ burrowClient: () => deps.burrowClient });
	const seedsCli: SeedsCliDeps = deps.seedsCli ?? {
		sdBinary: loadTriggerSchedulerConfigFromEnv().sdBinary,
		spawn: defaultSpawn,
	};

	let spawnResult: SpawnRunResult;
	try {
		spawnResult = await spawn({
			repos: deps.repos,
			runtimeProvider,
			agentName: args.agent,
			projectId: args.project,
			prompt: args.prompt,
			trigger: args.trigger ?? "cli",
			warrenConfigs,
			...(args.providerOverride !== undefined ? { providerOverride: args.providerOverride } : {}),
			...(args.modelOverride !== undefined ? { modelOverride: args.modelOverride } : {}),
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
			...(context.now !== undefined ? { now: context.now } : {}),
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1 };
	}

	const runId = spawnResult.run.id;
	writeJsonLine(context.stdio.stdout, {
		event: "run.spawned",
		runId,
		agent: spawnResult.run.agentName,
		project: spawnResult.run.projectId,
		burrowId: spawnResult.burrow.id,
		burrowRunId: spawnResult.burrowRun.id,
	});

	const bridgeAbort = new AbortController();
	const tailAbort = new AbortController();

	const bridgePromise: Promise<BridgeRunStreamResult> = bridge({
		runId,
		burrowRunId: spawnResult.burrowRun.id,
		burrowId: spawnResult.burrow.id,
		repos: deps.repos,
		broker,
		runtimeProvider,
		signal: bridgeAbort.signal,
	});

	// When the bridge finishes (burrow run reached a terminal state and
	// the stream closed), close the broker so the tail iterator returns.
	const bridgeDone = bridgePromise.finally(() => {
		broker.close(runId);
	});

	try {
		for await (const event of tailRunEvents({
			runId,
			repos: { events: deps.repos.events },
			broker,
			follow: true,
			signal: tailAbort.signal,
		})) {
			writeJsonLine(context.stdio.stdout, {
				event: "run.event",
				runId,
				seq: event.burrowEventSeq,
				ts: event.ts,
				kind: event.kind,
				stream: event.stream,
				payload: event.payloadJson,
			});
		}
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		bridgeAbort.abort();
		await bridgeDone.catch(() => undefined);
		return { exitCode: 1, runId };
	}

	await bridgeDone.catch(() => undefined);

	let outcome: RunTerminalState;
	try {
		outcome = await fetchBurrowRunState(spawnResult.burrowRun.id);
	} catch (err) {
		context.stdio.stderr.write(`warren: failed to read burrow run state: ${formatError(err)}\n`);
		// Best-effort: assume failed so the warren row finalizes rather than stays running.
		outcome = "failed";
	}

	let finalState: RunTerminalState = outcome;
	try {
		const reaped = await reap({
			runId,
			outcome,
			repos: deps.repos,
			runtimeProvider,
			// warren-e24d: preview sidecar seam, gated on the runtime's preview-port
			// capability (absent under K8s).
			...(runtimeProvider.capabilities.previewPorts
				? { previewSidecars: createLocalSidecarsResolver(deps.burrowClient) }
				: {}),
			broker,
			autoOpenPr,
			seedsCli,
			...(context.now !== undefined ? { now: context.now } : {}),
		});
		finalState = reaped.state;
		writeJsonLine(context.stdio.stdout, {
			event: "run.reaped",
			runId,
			state: finalState,
			alreadyTerminal: reaped.alreadyTerminal,
			mulch: {
				updated: reaped.mulchUpdated,
				skipped: reaped.mulchSkipped,
				appended: reaped.mulchAppended,
			},
			seedsClosed: reaped.seedsClosed,
			seedsCreated: reaped.seedsCreated,
			branchPushed: reaped.branchPushed,
			commitsAhead: reaped.commitsAhead,
			prUrl: reaped.prUrl,
			errors: reaped.errors,
		});
	} catch (err) {
		context.stdio.stderr.write(`warren: reap failed: ${formatError(err)}\n`);
		return { exitCode: 1, runId, state: outcome };
	}

	return {
		exitCode: finalState === "succeeded" ? 0 : 1,
		runId,
		state: finalState,
	};
}

function defaultFetchBurrowRunState(
	client: BurrowClient,
): (burrowRunId: string) => Promise<RunTerminalState> {
	return async (burrowRunId) => {
		// warren-76c5: the self-host backend is a single local burrow — fetch the
		// run's terminal state directly from the one client. A transport failure
		// propagates so `runRun` maps it to a non-zero exit + stderr line.
		const row = await withTransportMapping(client.config, () => client.http.runs.get(burrowRunId));
		const state = row.state;
		if (state === "succeeded" || state === "failed" || state === "cancelled") return state;
		return "failed";
	};
}
