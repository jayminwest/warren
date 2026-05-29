/**
 * Reconnect/stall machinery for the stream-bridge registry
 * (`./bridges.ts`). Extracted to keep both files under the file-size
 * ratchet (warren-4553). `runWithReconnect` runs `bridgeRunStream` in a
 * backoff loop, surfaces degraded state via `bridge_stalled` /
 * `bridge_recovered` system events (warren-6376), reaps inline on
 * terminal-detect, and reconciles ghost runs (warren-b1a9) via
 * `reconcileLostBurrowRun`, which `bootBridges` also calls at boot.
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventRow, RunState } from "../db/schema.ts";
import type { PreviewLaunchConfig } from "../preview/launch/index.ts";
import type { PreviewPortAllocator } from "../preview/port-allocator.ts";
import type {
	AutoOpenPrConfig,
	BridgeLogger,
	BridgeRunStreamInput,
	BridgeRunStreamResult,
	ReapRunInput,
	ReapRunResult,
	RunEventBroker,
} from "../runs/index.ts";
import type { PrTemplateOverrides } from "../runs/pr-template.ts";
import type { ServerPreviewConfig, WarrenConfigCache } from "../warren-config/index.ts";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

export interface RunWithReconnectInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly burrowId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly burrowClientPool: BurrowClientPool;
	readonly signal: AbortSignal;
	readonly bridge: (input: BridgeRunStreamInput) => Promise<BridgeRunStreamResult>;
	readonly reap: (input: ReapRunInput) => Promise<ReapRunResult>;
	readonly backoff: readonly number[];
	readonly stallThreshold: number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly logger?: BridgeLogger;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly portAllocator?: PreviewPortAllocator;
	readonly previewLaunchConfig?: PreviewLaunchConfig;
}

/**
 * Run `bridgeRunStream` in a loop, reconnecting on `errored: true`
 * with exponential backoff until the run is terminal in warren's DB,
 * the bridge ends naturally (`errored: false` ⇒ burrow closed the
 * stream because the run completed), or the registry aborts.
 */
export async function runWithReconnect(
	input: RunWithReconnectInput,
): Promise<BridgeRunStreamResult> {
	let totalWritten = 0;
	let totalSkipped = 0;
	let attempt = 0;
	// warren-6376: track whether we've emitted `bridge_stalled` so the
	// event is one-shot per stall episode and we know to emit a matching
	// `bridge_recovered` once fresh events stream again.
	let stalled = false;
	while (true) {
		const bridgeInput: BridgeRunStreamInput = {
			runId: input.runId,
			burrowRunId: input.burrowRunId,
			burrowId: input.burrowId,
			repos: input.repos,
			broker: input.broker,
			burrowClientPool: input.burrowClientPool,
			signal: input.signal,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		};
		const result = await input.bridge(bridgeInput);
		totalWritten += result.written;
		totalSkipped += result.skipped;

		// warren-6376: forward progress (fresh events streamed) clears any
		// active stall and resets the consecutive-error counter so backoff
		// starts fresh on the next drop.
		if (result.written > 0) {
			if (stalled) {
				await emitBridgeSystemEvent({
					runId: input.runId,
					repos: input.repos,
					broker: input.broker,
					kind: "bridge_recovered",
					payload: { burrowRunId: input.burrowRunId, totalWritten },
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				});
				input.logger?.info?.(
					{ runId: input.runId, burrowRunId: input.burrowRunId },
					"bridge recovered: events streaming again after stall",
				);
				stalled = false;
			}
			attempt = 0;
		}

		if (result.burrowRunMissing === true) {
			// warren-b1a9: burrow returned 404 mid-stream. The run is
			// unrecoverable — reconcile the warren row to `failed` so the UI,
			// /readyz, and the next bootBridges pass all stop treating it as
			// live. Don't reconnect; the only thing waiting on the wire is
			// another 404.
			await reconcileLostBurrowRun({
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				repos: input.repos,
				broker: input.broker,
				...(input.logger !== undefined ? { logger: input.logger } : {}),
			});
			return { written: totalWritten, skipped: totalSkipped, errored: false };
		}

		if (result.terminalDetected !== undefined) {
			// warren-a69a: bridge observed a runtime-terminal event. Reap
			// inline so the warren row finalizes without depending on an
			// external scheduler. reap is idempotent + best-effort, so
			// errors land as `reap.completed`/`reap_failed` events on the
			// run rather than escaping back up the registry.
			const previewConfig =
				result.terminalDetected.outcome === "succeeded"
					? await resolveProjectPreviewConfig(input)
					: undefined;
			const prTemplate =
				result.terminalDetected.outcome === "succeeded"
					? await resolveProjectPrTemplate(input)
					: undefined;
			try {
				await input.reap({
					runId: input.runId,
					outcome: result.terminalDetected.outcome,
					repos: input.repos,
					burrowClientPool: input.burrowClientPool,
					broker: input.broker,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
					...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
					...(previewConfig !== undefined ? { previewConfig } : {}),
					...(input.portAllocator !== undefined ? { portAllocator: input.portAllocator } : {}),
					...(input.previewLaunchConfig !== undefined
						? { previewLaunchConfig: input.previewLaunchConfig }
						: {}),
					...(prTemplate !== undefined ? { prTemplate } : {}),
				});
			} catch (err) {
				input.logger?.error?.(
					{
						runId: input.runId,
						burrowRunId: input.burrowRunId,
						err: err instanceof Error ? err.message : String(err),
					},
					"reap threw out of bridge terminal-detect path",
				);
			}
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}

		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: result.errored };
		}
		if (!result.errored) {
			return { written: totalWritten, skipped: totalSkipped, errored: false };
		}

		// errored=true: the source iterator threw before burrow signalled
		// run-completion. If warren has already finalized the run (reaper
		// won the race), stop — there's nothing left to courier. Else
		// back off and reconnect.
		const row = await input.repos.runs.get(input.runId);
		if (row === null || TERMINAL_RUN_STATES.has(row.state)) {
			input.logger?.info?.(
				{ runId: input.runId, burrowRunId: input.burrowRunId, state: row?.state ?? "unknown" },
				"bridge reconnect stopped: run is terminal",
			);
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}

		const delayMs = input.backoff[Math.min(attempt, input.backoff.length - 1)] ?? 0;
		attempt += 1;
		input.logger?.warn?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				attempt,
				delayMs,
				totalWritten,
				totalSkipped,
			},
			"bridge errored — reconnecting after backoff",
		);
		// warren-6376: after N consecutive errored reconnects with no
		// forward progress, surface a one-shot `bridge_stalled` system
		// event so the UI can show "agent infrastructure unreachable"
		// rather than an indefinite spinner. The reconnect loop keeps
		// running underneath; `bridge_recovered` fires when events flow.
		if (!stalled && attempt >= input.stallThreshold) {
			await emitBridgeSystemEvent({
				runId: input.runId,
				repos: input.repos,
				broker: input.broker,
				kind: "bridge_stalled",
				payload: { burrowRunId: input.burrowRunId, attempts: attempt },
				...(input.logger !== undefined ? { logger: input.logger } : {}),
			});
			input.logger?.warn?.(
				{ runId: input.runId, burrowRunId: input.burrowRunId, attempts: attempt },
				"bridge stalled: burrow unreachable across consecutive reconnects",
			);
			stalled = true;
		}
		try {
			await input.sleep(delayMs, input.signal);
		} catch {
			// AbortError — signal fired during sleep. Bail out cleanly.
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
		if (input.signal.aborted) {
			return { written: totalWritten, skipped: totalSkipped, errored: true };
		}
	}
}

/**
 * Resolve the project's `.warren/defaults.json` preview block (R-19) for
 * the run the bridge just observed reach terminal. Returns `undefined`
 * when the project hasn't opted in or when the warren-config seam isn't
 * wired (tests that omit `warrenConfigs`/`portAllocator`). The launcher
 * gate inside reap is what skips the actual preview spawn when this
 * function returns `undefined`.
 *
 * Errors from the per-project loader (`malformed defaults.json`, etc.)
 * surface as a `null` defaults block, so this function returns
 * `undefined` and the preview just skips. Operators see the underlying
 * error via the `/projects/:id/warren-config` route.
 */
async function resolveProjectPreviewConfig(
	input: RunWithReconnectInput,
): Promise<ServerPreviewConfig | undefined> {
	if (input.warrenConfigs === undefined || input.portAllocator === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const preview = config.defaults?.preview;
		if (preview === undefined) return undefined;
		// `type: 'static'` is filed as a follow-up (per SPEC §11.L); reap
		// would reject at launch time anyway. Skip cleanly here so the
		// PR-body placeholder doesn't promise a preview that can't run.
		if (preview.type !== "server") return undefined;
		return preview;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview config load failed; skipping preview launch",
		);
		return undefined;
	}
}

/**
 * Resolve the project's `.warren/pr-template.md` fragment overrides
 * (warren-bd49) for the run the bridge just observed reach terminal.
 * Returns `undefined` when the project ships no template, when the
 * warren-config seam isn't wired (tests), or when the parsed envelope
 * has no overrides. Errors from the per-project loader surface as
 * a `null` prTemplate in the envelope, so this just falls through to
 * `undefined` and reap uses the built-in defaults. Operators see the
 * underlying error via `/projects/:id/warren-config`.
 */
async function resolveProjectPrTemplate(
	input: RunWithReconnectInput,
): Promise<PrTemplateOverrides | undefined> {
	if (input.warrenConfigs === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const overrides = config.prTemplate;
		if (overrides === null || overrides === undefined) return undefined;
		if (Object.keys(overrides).length === 0) return undefined;
		return overrides;
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"pr-template load failed; falling back to built-in defaults",
		);
		return undefined;
	}
}

interface EmitBridgeSystemEventInput {
	readonly runId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
	readonly logger?: BridgeLogger;
}

/**
 * warren-6376: append a synthetic `stream: 'system'` event for the run
 * and publish it to the live broker. Used for the bridge's degraded-state
 * signalling (`bridge_stalled` / `bridge_recovered`). Best-effort: a
 * failure to persist is logged but never escapes the reconnect loop.
 */
async function emitBridgeSystemEvent(input: EmitBridgeSystemEventInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			burrowEventSeq: seq,
			ts: new Date().toISOString(),
			kind: input.kind,
			stream: "system",
			payload: input.payload,
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				kind: input.kind,
				err: err instanceof Error ? err.message : String(err),
			},
			"failed to emit bridge system event",
		);
	}
}

interface ReconcileLostBurrowRunInput {
	readonly runId: string;
	readonly burrowRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly logger?: BridgeLogger;
	readonly now?: () => Date;
}

/**
 * warren-b1a9: transition a non-terminal warren run to `failed` with
 * `failure_reason='burrow_run_lost'` and emit a `bridge_lost` audit event.
 * Used both by the live-bridge 404 catch and by the boot-time reconciler.
 * Idempotent: a run that's already terminal is left alone (the event is
 * still appended so the UI shows why the bridge stopped).
 *
 * The state machine doesn't allow `queued → failed` directly, so this
 * mirrors reap's `markRunning` shim for queued ghost runs (run never made
 * it to running because the bridge never claimed before burrow lost it).
 */
export async function reconcileLostBurrowRun(input: ReconcileLostBurrowRunInput): Promise<void> {
	const now = (input.now ?? (() => new Date()))();
	let finalized = false;
	try {
		const run = await input.repos.runs.get(input.runId);
		if (run === null) {
			return;
		}
		if (TERMINAL_RUN_STATES.has(run.state)) {
			input.logger?.info?.(
				{ runId: input.runId, state: run.state },
				"reconcileLostBurrowRun: run already terminal; skipping finalize",
			);
		} else {
			if (run.state === "queued") {
				await input.repos.runs.markRunning(input.runId, now);
			}
			await input.repos.runs.finalize(input.runId, "failed", now, "burrow_run_lost");
			finalized = true;
		}
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				burrowRunId: input.burrowRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostBurrowRun: failed to finalize run",
		);
	}
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row: EventRow = await input.repos.events.append({
			runId: input.runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "bridge_lost",
			stream: "system",
			payload: {
				burrowRunId: input.burrowRunId,
				reason: "burrow_run_lost",
				finalized,
			},
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"reconcileLostBurrowRun: failed to emit bridge_lost event",
		);
	}
	input.logger?.warn?.(
		{ runId: input.runId, burrowRunId: input.burrowRunId, finalized },
		"reconciled ghost run: burrow no longer knows this burrow_run_id",
	);
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
