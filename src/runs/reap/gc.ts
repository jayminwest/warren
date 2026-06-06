/**
 * Fallback garbage collection for stranded burrow workspaces (warren-0a9a,
 * follow-up to the per-reap `workspace_destroy` of warren-0d89).
 *
 * Per-reap destroy (`./destroy.ts`) covers the happy path: when a run
 * reaches a terminal state, reap destroys its burrow workspace so the
 * persistent volume doesn't fill up (the 2026-05-27 disk-full incident).
 * But edge cases strand workspaces:
 *
 *   - warren crashes mid-reap, after the run transitioned terminal but
 *     before `workspace_destroy` ran;
 *   - a stuck run is force-killed / cancelled out of band before reap got
 *     a chance to destroy its burrow;
 *   - a `workspace_destroy` sub-step failed (best-effort, never blocks the
 *     terminal transition — see `runWorkspaceDestroy`).
 *
 * This module provides a periodic sweep: walk the `burrows` placement table,
 * find rows whose runs are all terminal and whose newest activity is older
 * than a configurable TTL, and destroy each one. It is intentionally
 * conservative — a burrow with any non-terminal (`queued` / `running` /
 * `paused`) run is never touched, and every destroy is best-effort so one
 * unreachable worker can't stall the sweep.
 *
 * The same `findStrandedBurrows` predicate backs the `warren doctor` /
 * `/readyz` stale-workspace diagnostic (`src/diagnostics/checks.ts`) so the
 * report and the reaper agree on what "stranded" means.
 */

import { NotFoundError as BurrowNotFoundError, type DestroyBurrowResult } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import { ValidationError } from "../../core/errors.ts";
import type { BurrowRow, RunRow, RunState } from "../../db/schema.ts";
import { parseDurationMs } from "../../preview/duration.ts";

/** Non-terminal run states — a burrow with one of these is never GC'd. */
export const GC_ACTIVE_RUN_STATES: readonly RunState[] = ["queued", "running", "paused"];
/** Terminal run states — their newest `endedAt` ages a burrow off. */
export const GC_TERMINAL_RUN_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export const WARREN_WORKSPACE_GC_TTL_ENV = "WARREN_WORKSPACE_GC_TTL" as const;
export const WARREN_WORKSPACE_GC_TICK_MS_ENV = "WARREN_WORKSPACE_GC_TICK_MS" as const;
export const WARREN_WORKSPACE_GC_DISABLED_ENV = "WARREN_WORKSPACE_GC_DISABLED" as const;

/**
 * Default TTL before a burrow with only terminal runs is considered
 * stranded. 1h is comfortably past any in-progress reap (per-reap destroy
 * fires within seconds of the terminal transition) but tight enough to cap
 * disk growth from crash-stranded workspaces.
 */
export const DEFAULT_WORKSPACE_GC_TTL_MS = 60 * 60_000;
/** Default sweep cadence; 5m keeps disk pressure bounded without churn. */
export const DEFAULT_WORKSPACE_GC_TICK_MS = 5 * 60_000;

export interface WorkspaceGcConfig {
	readonly ttlMs: number;
	readonly tickMs: number;
	readonly disabled: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve workspace-GC config from env. Defaults are conservative;
 * malformed values fail loudly at boot rather than degrading at tick time
 * (mirrors `loadPreviewEvictionConfigFromEnv`).
 */
export function loadWorkspaceGcConfigFromEnv(env: EnvLike = process.env): WorkspaceGcConfig {
	const ttlMs = parseEnvDuration(env, WARREN_WORKSPACE_GC_TTL_ENV, DEFAULT_WORKSPACE_GC_TTL_MS);
	const tickMs = parseEnvPositiveInt(
		env,
		WARREN_WORKSPACE_GC_TICK_MS_ENV,
		DEFAULT_WORKSPACE_GC_TICK_MS,
	);
	const disabled = isTruthy(env[WARREN_WORKSPACE_GC_DISABLED_ENV]);
	return { ttlMs, tickMs, disabled };
}

function parseEnvDuration(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	try {
		return parseDurationMs(raw);
	} catch (err) {
		const message = err instanceof ValidationError ? err.message : String(err);
		throw new ValidationError(`${name}: ${message}`);
	}
}

function parseEnvPositiveInt(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
		throw new ValidationError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return parsed;
}

function isTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

/* ----------------------------------------------------------------------- */
/* Stranded-burrow predicate (shared with the doctor / readyz check)        */
/* ----------------------------------------------------------------------- */

export interface StrandedBurrow {
	readonly burrowId: string;
	readonly workerId: string;
	/** ISO timestamp the age check ran against (latest run end, else added). */
	readonly idleSince: string;
	/** Age in ms at sweep time (now − idleSince), always ≥ ttlMs. */
	readonly ageMs: number;
}

export interface BurrowActivity {
	/** Burrow ids with a non-terminal run; never GC candidates. */
	readonly activeBurrowIds: ReadonlySet<string>;
	/** Most-recent terminal `endedAt` per burrow id. */
	readonly latestEndedAt: ReadonlyMap<string, string>;
}

/**
 * Reduce active + terminal run rows into the per-burrow activity summary
 * the stranded-burrow predicate needs. Shared by the GC sweep and the
 * `warren doctor` / `/readyz` stale-workspace check so both age burrows the
 * same way without a bespoke repo aggregate query.
 */
export function buildBurrowActivity(
	activeRuns: readonly RunRow[],
	terminalRuns: readonly RunRow[],
): BurrowActivity {
	const activeBurrowIds = new Set<string>();
	for (const r of activeRuns) {
		if (r.burrowId !== null) activeBurrowIds.add(r.burrowId);
	}
	const latestEndedAt = new Map<string, string>();
	for (const r of terminalRuns) {
		if (r.burrowId === null || r.endedAt === null) continue;
		const prev = latestEndedAt.get(r.burrowId);
		if (prev === undefined || r.endedAt > prev) latestEndedAt.set(r.burrowId, r.endedAt);
	}
	return { activeBurrowIds, latestEndedAt };
}

export interface FindStrandedInput extends BurrowActivity {
	readonly burrows: readonly BurrowRow[];
	readonly ttlMs: number;
	readonly now: Date;
}

/**
 * Pure predicate: which burrow rows are stranded right now. A burrow is
 * stranded when it has no live run AND its newest activity (latest terminal
 * `endedAt`, falling back to the row's `addedAt`) is at least `ttlMs` old.
 * Sorted oldest-first so a capped sweep reclaims the stalest disk first.
 */
export function findStrandedBurrows(input: FindStrandedInput): StrandedBurrow[] {
	const nowMs = input.now.getTime();
	const out: StrandedBurrow[] = [];
	for (const row of input.burrows) {
		if (input.activeBurrowIds.has(row.id)) continue;
		const idleSince = input.latestEndedAt.get(row.id) ?? row.addedAt;
		const idleMs = Date.parse(idleSince);
		if (Number.isNaN(idleMs)) continue;
		const ageMs = nowMs - idleMs;
		if (ageMs < input.ttlMs) continue;
		out.push({ burrowId: row.id, workerId: row.workerId, idleSince, ageMs });
	}
	out.sort((a, b) => b.ageMs - a.ageMs);
	return out;
}

/* ----------------------------------------------------------------------- */
/* Sweep                                                                    */
/* ----------------------------------------------------------------------- */

export interface WorkspaceGcLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface WorkspaceGcReposLike {
	readonly burrows: {
		listAll(): Promise<BurrowRow[]>;
		delete(id: string): Promise<void>;
	};
	readonly runs: {
		listByState(state: RunState[]): Promise<RunRow[]>;
	};
}

export interface WorkspaceGcPoolLike {
	clientFor(input: { burrowId: string }): Promise<{ client: BurrowClient }>;
}

export interface WorkspaceGcTickInput {
	readonly repos: WorkspaceGcReposLike;
	readonly burrowClientPool: WorkspaceGcPoolLike;
	readonly config: WorkspaceGcConfig;
	readonly now?: () => Date;
	readonly logger?: WorkspaceGcLogger;
	/** Override the burrow destroy seam (tests). */
	readonly destroyBurrow?: (client: BurrowClient, burrowId: string) => Promise<DestroyBurrowResult>;
}

export interface WorkspaceGcTickResult {
	readonly scanned: number;
	readonly stranded: number;
	readonly destroyed: number;
	readonly failed: number;
}

function defaultDestroy(client: BurrowClient, burrowId: string): Promise<DestroyBurrowResult> {
	return client.http.burrows.destroy(burrowId, { archive: true });
}

/**
 * One GC sweep: find stranded burrows and destroy each. Best-effort —
 * a destroy failure (unreachable worker, burrow already gone) is logged and
 * counted but never throws, so a single bad row can't stall the loop. On a
 * successful destroy the warren-side `burrows` placement row is deleted so
 * `clientFor()` routing won't point at a dead workspace.
 */
export async function runWorkspaceGcTick(
	input: WorkspaceGcTickInput,
): Promise<WorkspaceGcTickResult> {
	const now = (input.now ?? (() => new Date()))();
	const destroyFn = input.destroyBurrow ?? defaultDestroy;

	const [burrows, activeRuns, terminalRuns] = await Promise.all([
		input.repos.burrows.listAll(),
		input.repos.runs.listByState([...GC_ACTIVE_RUN_STATES]),
		input.repos.runs.listByState([...GC_TERMINAL_RUN_STATES]),
	]);

	const stranded = findStrandedBurrows({
		burrows,
		...buildBurrowActivity(activeRuns, terminalRuns),
		ttlMs: input.config.ttlMs,
		now,
	});

	let destroyed = 0;
	let failed = 0;
	for (const candidate of stranded) {
		const ok = await destroyOne(input, candidate, destroyFn);
		if (ok) destroyed += 1;
		else failed += 1;
	}

	if (stranded.length > 0) {
		input.logger?.info(
			{ scanned: burrows.length, stranded: stranded.length, destroyed, failed },
			"workspace_gc.swept",
		);
	}

	return { scanned: burrows.length, stranded: stranded.length, destroyed, failed };
}

async function destroyOne(
	input: WorkspaceGcTickInput,
	candidate: StrandedBurrow,
	destroyFn: (client: BurrowClient, burrowId: string) => Promise<DestroyBurrowResult>,
): Promise<boolean> {
	try {
		const { client } = await input.burrowClientPool.clientFor({ burrowId: candidate.burrowId });
		const result = await withTransportMapping(client.config, () =>
			destroyFn(client, candidate.burrowId),
		);
		await input.repos.burrows.delete(candidate.burrowId);
		input.logger?.info(
			{
				burrowId: candidate.burrowId,
				ageMs: candidate.ageMs,
				archived: result.archived !== null,
				deletedEvents: result.deletedEvents,
				deletedRuns: result.deletedRuns,
			},
			"workspace_gc.destroyed",
		);
		return true;
	} catch (err) {
		// 404 from burrow means the workspace is already gone on burrow's side.
		// Prune the warren-side placement row so we stop retrying on every sweep.
		if (err instanceof BurrowNotFoundError) {
			try {
				await input.repos.burrows.delete(candidate.burrowId);
			} catch {
				// Best-effort; will be retried next sweep.
			}
			input.logger?.info(
				{ burrowId: candidate.burrowId, workerId: candidate.workerId },
				"workspace_gc.already_gone",
			);
			return true;
		}
		input.logger?.warn(
			{
				burrowId: candidate.burrowId,
				workerId: candidate.workerId,
				err: err instanceof Error ? err.message : String(err),
			},
			"workspace_gc.destroy_failed",
		);
		return false;
	}
}

/* ----------------------------------------------------------------------- */
/* Periodic worker                                                          */
/* ----------------------------------------------------------------------- */

export type WorkspaceGcTimerHandle = object;

export interface WorkspaceGcWorkerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one sweep synchronously and await completion. */
	runOnce(): Promise<WorkspaceGcTickResult | null>;
	/** Test/diagnostic surface — completed sweep count. */
	tickCount(): number;
}

export interface StartWorkspaceGcWorkerInput extends WorkspaceGcTickInput {
	readonly setInterval?: (cb: () => void, ms: number) => WorkspaceGcTimerHandle;
	readonly clearInterval?: (handle: WorkspaceGcTimerHandle) => void;
}

const NOOP_HANDLE = Symbol("workspace-gc-noop") as unknown as WorkspaceGcTimerHandle;

/**
 * Boot the fallback workspace-GC sweep. Mirrors `startPreviewEvictionWorker`:
 * single-flight (a sweep in flight when the next interval fires is dropped,
 * not stacked) and `stop()` awaits the in-flight sweep so teardown doesn't
 * race the next `burrows.delete`.
 */
export function startWorkspaceGcWorker(
	input: StartWorkspaceGcWorkerInput,
): WorkspaceGcWorkerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => WorkspaceGcTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as WorkspaceGcTimerHandle);
	const clearIntervalFn: (handle: WorkspaceGcTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<WorkspaceGcTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const runTickAndCount = async (): Promise<WorkspaceGcTickResult | null> => {
		try {
			const result = await runWorkspaceGcTick(input);
			ticks += 1;
			return result;
		} catch (err) {
			input.logger?.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"workspace_gc.tick_failed",
			);
			return null;
		} finally {
			inFlight = null;
		}
	};

	const fire = async (): Promise<WorkspaceGcTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "workspace_gc.tick_skipped");
			return null;
		}
		const promise = runTickAndCount();
		inFlight = promise;
		return promise;
	};

	const handle: WorkspaceGcTimerHandle = input.config.disabled
		? NOOP_HANDLE
		: setIntervalFn(() => void fire(), input.config.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// Already logged inside runTickAndCount().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
