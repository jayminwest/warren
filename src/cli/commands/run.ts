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
import type { RunHandle, RuntimeProvider } from "../../runtime/contract.ts";
import type { LocalSidecarsResolver } from "../../runtime/local/preview/sidecars.ts";
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
	 * Boot-resolved runtime provider for the whole run lifecycle (warren-11cc).
	 * REQUIRED: `main.ts` resolves it once (honoring `WARREN_RUNTIME`) via
	 * `resolveLocalRunBackend` and threads it here; `spawnRun`, `bridgeRunStream`,
	 * `reapRun`, and the terminal-state read all dispatch through it — the run
	 * command no longer touches a burrow client. Tests inject a stub.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * Preview sidecar seam (warren-11cc), capability-gated by `main.ts` on
	 * `runtimeProvider.capabilities.previewPorts`. Present only for the local
	 * backend; absent under `WARREN_RUNTIME=k8s`, so reap's preview sub-step goes
	 * dark exactly as it does for a project without preview config.
	 */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Optional broker injection — defaults to a fresh broker per run. */
	readonly broker?: RunEventBroker;
	/** Override the bridge factory (tests). Defaults to the live `bridgeRunStream`. */
	readonly bridge?: typeof bridgeRunStream;
	/** Override the spawn function (tests). Defaults to the live `spawnRun`. */
	readonly spawn?: typeof spawnRun;
	/** Override reap (tests). Defaults to the live `reapRun`. */
	readonly reap?: typeof reapRun;
	/**
	 * Override the terminal-state fallback lookup (tests). Consulted only when
	 * the bridge detected no in-stream terminal envelope (warren-2909).
	 * Defaults to a bounded-retry `provider.status(handle)` read — the
	 * provider seam, not a burrow client.
	 */
	readonly fetchBurrowRunState?: (handle: RunHandle) => Promise<RunTerminalState>;
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
	// The active runtime provider is boot-resolved in `main.ts` (honoring
	// WARREN_RUNTIME) and shared across spawn + the stream bridge + reap + the
	// terminal-state read: every burrow interaction crosses the provider seam,
	// not a burrow client (warren-11cc).
	const runtimeProvider = deps.runtimeProvider;
	const fetchBurrowRunState = deps.fetchBurrowRunState ?? defaultFetchRunState(runtimeProvider);
	const seedsCli: SeedsCliDeps = deps.seedsCli ?? {
		sdBinary: loadTriggerSchedulerConfigFromEnv().sdBinary,
		spawn: defaultSpawn,
	};

	let handle: RunHandle | undefined;
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
	handle = {
		runId,
		sandboxId: spawnResult.burrow.id,
		providerRunId: spawnResult.burrowRun.id,
	};
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
	const bridgeResult = await bridgePromise.catch(() => undefined);

	// warren-2909 / GH #663: prefer the bridge's in-stream terminal
	// detection (`detectRuntimeTerminal` on the result envelope's
	// `is_error`) over the status() probe. The probe races burrow's
	// finalize — the terminal envelope can arrive while burrow still
	// reports `running`, and a one-shot read then mislabels a clean run
	// as failed/crashed, skipping PR auto-open. The probe is the fallback
	// for runs whose runtime emits no in-stream terminal envelope (or
	// whose bridge errored).
	const terminal = bridgeResult?.terminalDetected;

	let outcome: RunTerminalState;
	if (terminal !== undefined) {
		outcome = terminal.outcome;
	} else {
		try {
			outcome = await fetchBurrowRunState(handle);
		} catch (err) {
			context.stdio.stderr.write(`warren: failed to read burrow run state: ${formatError(err)}\n`);
			// Best-effort: assume failed so the warren row finalizes rather than stays running.
			outcome = "failed";
		}
	}

	let finalState: RunTerminalState = outcome;
	try {
		const reaped = await reap({
			runId,
			outcome,
			// warren-2909: an explicit failure reason the bridge distilled
			// in-stream (e.g. `oom_killed`) overrides reap's inference.
			...(terminal?.failureReason !== undefined ? { failureReason: terminal.failureReason } : {}),
			repos: deps.repos,
			runtimeProvider,
			// warren-11cc: preview sidecar seam, capability-gated by main.ts on the
			// runtime's preview-port capability (absent under K8s).
			...(deps.previewSidecars !== undefined ? { previewSidecars: deps.previewSidecars } : {}),
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

/** Fallback status()-probe poll cadence (ms) — see warren-2909. */
const FINALIZE_POLL_MS = 250;
/**
 * Fallback status()-probe budget (ms). burrow finalizes the run row a few
 * hundred ms after the terminal envelope; 5s is comfortably past a healthy
 * finalize while staying bounded for a genuinely wedged one.
 */
const FINALIZE_TIMEOUT_MS = 5_000;

export function defaultFetchRunState(
	provider: RuntimeProvider,
	opts?: {
		readonly pollMs?: number;
		readonly timeoutMs?: number;
		readonly sleep?: (ms: number) => Promise<void>;
	},
): (handle: RunHandle) => Promise<RunTerminalState> {
	const pollMs = opts?.pollMs ?? FINALIZE_POLL_MS;
	const timeoutMs = opts?.timeoutMs ?? FINALIZE_TIMEOUT_MS;
	const sleep =
		opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	return async (handle) => {
		// warren-11cc: read the run's terminal state through the provider seam
		// (`status()` never throws on a missing run — it reports `exists:false`).
		// warren-2909: tolerate burrow's finalize lag — while the phase is still
		// `queued`/`running`, retry on a bounded budget instead of mapping the
		// first non-terminal read straight to `failed`. A run that never reaches
		// terminal within the budget maps to `failed` so the warren row finalizes
		// rather than stranding as running.
		const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const status = await provider.status(handle);
			const phase = status.phase;
			if (phase === "succeeded" || phase === "failed" || phase === "cancelled") return phase;
			if (attempt < maxAttempts - 1) await sleep(pollMs);
		}
		return "failed";
	};
}
