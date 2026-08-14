/**
 * Merge watcher — the post_reap lifecycle-bus subscriber that settles a
 * run's PR (warren-3bc6, plan pl-103e step 6).
 *
 * ## What it is
 *
 * The plan-run coordinator already polls PRs through the Forge seam
 * (`../pr-merge.ts`, consumer 1 — retry-aware single polls driven by the
 * coordinator's tick). This module is consumer 2: a `post_reap`
 * subscriber (`../lifecycle-bus.ts`) that takes over the PR of ANY reaped
 * run — not just plan-run children — and polls the boot-resolved forge
 * until the PR reaches a terminal lifecycle, writing `pr_state` +
 * `pr_merged_at` onto the run row as it goes. Success flips from
 * exit-code to landed-work semantics (agent-analytics.md §5.3).
 *
 * ## Poll-until-terminal discipline (mirrors merge-gate.ts)
 *
 *   - `merged` → write `pr_state=merged` + the forge-reported
 *     `pr_merged_at`, STOP.
 *   - `closed_unmerged` → write `pr_state=closed_unmerged`, STOP.
 *   - `unparseable` (foreign-host PR no forge owns) → STOP, leaving
 *     `pr_state` NULL. NULL reads as "unknown", never "not merged".
 *   - `open` → write `pr_state=open` (first observation) and keep
 *     polling on a bounded exponential backoff.
 *   - `forge_error` → only `not_found` is fatal (the PR is genuinely
 *     gone — stop, leave NULL); everything else keeps waiting, bounded by
 *     the watch budget. The checker inside already retried the transient
 *     kinds and fired its loud once-per-repo notice for unauthorized.
 *
 * ## Rate-limit care
 *
 * One open PR costs one forge call per backoff interval, capped at
 * {@link DEFAULT_MAX_INTERVAL_MS}, and the whole watch expires after
 * {@link DEFAULT_MAX_WATCH_MS}. Boot re-adoption (a restart re-adopts
 * every run with `pr_url` set and a non-terminal `pr_state`) staggers
 * the first poll of each adopted watch by one initial interval per
 * already-watching run, so a fleet of stale open PRs fans out across the
 * backoff ladder instead of hammering the forge in one burst.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { LifecycleExtension } from "../lifecycle-bus.ts";
import { WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
import { createPrMergeChecker, type PrMergeChecker, type PrMergePollResult } from "../pr-merge.ts";

/** First poll after adoption (and the boot re-adoption stagger quantum). */
export const DEFAULT_INITIAL_INTERVAL_MS = 60_000;
/** Backoff ceiling — one forge call per open PR per interval, max. */
export const DEFAULT_MAX_INTERVAL_MS = 15 * 60_000;
/** A PR this old without resolution is abandoned; NULL pr_state = unknown. */
export const DEFAULT_MAX_WATCH_MS = 7 * 24 * 60 * 60_000;

/** Minimal structured-logger surface the watcher needs. */
export interface PrMergeWatcherLogger {
	warn(obj: Record<string, unknown>, msg: string): void;
	error(obj: Record<string, unknown>, msg: string): void;
}

export interface CreatePrMergeWatcherInput {
	readonly repos: Repos;
	/** Boot-resolved forge (ServerDeps.forge) — never a per-tick instance. */
	readonly forge: Forge;
	readonly logger: PrMergeWatcherLogger;
	/** Test seam: a pre-built checker replaces the forge-derived one. */
	readonly checker?: PrMergeChecker;
	/** Test seam for the backoff delay. */
	readonly sleep?: (ms: number) => Promise<void>;
	readonly initialIntervalMs?: number;
	readonly maxIntervalMs?: number;
	readonly maxWatchMs?: number;
	readonly now?: () => Date;
}

export interface PrMergeWatcher {
	/** The lifecycle extension to register on the bus. */
	readonly extension: LifecycleExtension;
	/**
	 * Start watching a run's PR (idempotent per run — a second adopt of an
	 * already-watched run is a no-op). Used by the post_reap hook and by
	 * boot re-adoption; `staggerMs` delays the first poll.
	 */
	adopt(runId: string, prUrl: string, staggerMs?: number): void;
	/** Cancel every in-flight watch (boot teardown / tests). */
	stop(): void;
	/** Diagnostic: number of runs currently being watched. */
	readonly watching: number;
}

interface WatchEntry {
	cancelled: boolean;
	cancelSleep: (() => void) | null;
}

/**
 * Build the merge watcher. Register `watcher.extension` through
 * `registerExtensions` at boot, then re-adopt unresolved PRs off
 * `repos.runs.listWithUnresolvedPr()`.
 */
export function createPrMergeWatcher(input: CreatePrMergeWatcherInput): PrMergeWatcher {
	const { repos, logger } = input;
	const checker = input.checker ?? createPrMergeChecker({ forge: input.forge, logger });
	const sleep = input.sleep ?? defaultSleep;
	const initialIntervalMs = input.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
	const maxIntervalMs = input.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
	const maxWatchMs = input.maxWatchMs ?? DEFAULT_MAX_WATCH_MS;
	const now = input.now ?? (() => new Date());
	const entries = new Map<string, WatchEntry>();

	// Resolves when the delay elapses OR when stop() cancels the watch —
	// with the default setTimeout sleep the abandoned timer is harmless
	// (the loop re-checks entry.cancelled before polling again).
	const interruptibleSleep = (ms: number, entry: WatchEntry): Promise<void> => {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			entry.cancelSleep = resolve;
			void sleep(ms).then(() => {
				entry.cancelSleep = null;
				resolve();
			});
		});
	};

	/** One poll: write what the forge said, report whether the watch ends. */
	const pollOnce = async (runId: string, prUrl: string): Promise<"done" | "keep"> => {
		const polled = await checker(prUrl);
		const disposition = classifyPoll(polled);
		if (disposition.action === "settle") {
			await repos.runs.setPrState(runId, disposition.prState, disposition.prMergedAt);
			return "done";
		}
		if (disposition.action === "stop") {
			logger.warn({ runId, prUrl, detail: disposition.detail }, disposition.logMsg);
			return "done";
		}
		if (polled.kind === "open") {
			// First observation stamps `open`; the rewrite on later polls is
			// an idempotent re-assert, one write per backoff interval.
			await repos.runs.setPrState(runId, "open", null);
		}
		return "keep";
	};

	/** Back off one interval — or report the watch budget exhausted. */
	const pauseOrExpire = async (
		runId: string,
		prUrl: string,
		entry: WatchEntry,
		startedAt: number,
		intervalMs: number,
	): Promise<boolean> => {
		if (now().getTime() - startedAt >= maxWatchMs) {
			logger.warn({ runId, prUrl }, "pr_merge_watch.budget_exceeded");
			return true;
		}
		await interruptibleSleep(intervalMs, entry);
		return false;
	};

	const pollLoop = async (runId: string, prUrl: string, entry: WatchEntry): Promise<void> => {
		const startedAt = now().getTime();
		let intervalMs = initialIntervalMs;
		for (;;) {
			if (entry.cancelled) return;
			const step = await pollOnce(runId, prUrl);
			if (entry.cancelled || step === "done") return;
			if (await pauseOrExpire(runId, prUrl, entry, startedAt, intervalMs)) return;
			intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
		}
	};

	const watch = async (runId: string, prUrl: string, entry: WatchEntry): Promise<void> => {
		try {
			await pollLoop(runId, prUrl, entry);
		} catch (error) {
			logger.error(
				{ runId, prUrl, reason: error instanceof Error ? error.message : String(error) },
				"pr_merge_watch.failed",
			);
		} finally {
			entries.delete(runId);
		}
	};

	const watcher: PrMergeWatcher = {
		extension: {
			name: "pr-merge-watcher",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				post_reap: (envelope) => {
					// Capability, not conditional (rule 7): this hook IS "settle
					// the reaped run's PR." Runs without a PR have nothing to poll.
					if (envelope.payload.prUrl === null) return;
					watcher.adopt(envelope.payload.runId, envelope.payload.prUrl);
				},
			},
		},
		adopt(runId, prUrl, staggerMs = 0) {
			if (entries.has(runId)) return;
			const entry: WatchEntry = { cancelled: false, cancelSleep: null };
			entries.set(runId, entry);
			const start = async () => {
				// Boot re-adoption stagger: the first poll of each adopted watch
				// is delayed by one initial interval per already-watching run, so
				// a fleet of stale open PRs fans out across the backoff ladder.
				if (staggerMs > 0) await interruptibleSleep(staggerMs, entry);
				await watch(runId, prUrl, entry);
			};
			void start();
		},
		stop() {
			for (const entry of entries.values()) {
				entry.cancelled = true;
				entry.cancelSleep?.();
			}
		},
		get watching() {
			return entries.size;
		},
	};
	return watcher;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What one poll means for the watch (the terminal-stop discipline,
 * mirroring merge-gate.ts): terminal lifecycles settle the row and stop;
 * `unparseable` and a fatal `not_found` stop leaving `pr_state` NULL
 * (unknown, never failure); everything else keeps polling on backoff.
 */
type PollDisposition =
	| {
			readonly action: "settle";
			readonly prState: "merged" | "closed_unmerged";
			readonly prMergedAt: string | null;
	  }
	| { readonly action: "stop"; readonly logMsg: string; readonly detail: string }
	| { readonly action: "keep_polling" };

function classifyPoll(polled: PrMergePollResult): PollDisposition {
	if (polled.kind === "merged") {
		return { action: "settle", prState: "merged", prMergedAt: polled.mergedAt };
	}
	if (polled.kind === "closed_unmerged") {
		return { action: "settle", prState: "closed_unmerged", prMergedAt: null };
	}
	if (polled.kind === "unparseable") {
		return { action: "stop", logMsg: "pr_merge_watch.unparseable", detail: polled.detail };
	}
	if (polled.kind === "forge_error" && polled.errorKind === "not_found") {
		return { action: "stop", logMsg: "pr_merge_watch.pr_not_found", detail: polled.detail };
	}
	return { action: "keep_polling" };
}
