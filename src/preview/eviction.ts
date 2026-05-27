/**
 * Preview TTL + LRU eviction worker (R-19 / SPEC §11.L, warren-ea6b).
 *
 * Periodic tick that walks every preview in `starting`/`live` and evicts on
 * the four-signal contract from the design lock:
 *
 *   1. **Idle-TTL (primary).** Evicts when `now - preview_last_hit_at >
 *      idle_ttl`. Per-project override from `.warren/defaults.json`
 *      (`preview.idle_ttl`) takes precedence over the global env
 *      `WARREN_PREVIEW_IDLE_TTL` (default 30m). A preview that never got a
 *      proxy hit yet falls back to `preview_started_at` for the idle clock
 *      so a launched-but-never-visited preview still ages out.
 *
 *   2. **Max-lifetime ceiling.** Evicts when `now - preview_started_at >
 *      max_lifetime`. Same precedence: per-project override > global env
 *      `WARREN_PREVIEW_MAX_LIFETIME` (default 8h). Stops the "browser tab
 *      from yesterday auto-refreshing" failure mode that defeats idle-TTL
 *      alone.
 *
 *   3. **Global LRU cap.** After the per-row TTL pass, if the remaining
 *      live count still exceeds `WARREN_PREVIEW_MAX_LIVE` (default 20),
 *      evict the longest-idle previews until the count is back at the cap.
 *      Bounds container memory even when individual previews are within
 *      their TTLs. The `/readyz` saturation warning (>80% of cap) lives
 *      in `src/diagnostics/checks.ts`.
 *
 *   4. **Manual teardown.** Out of scope for this module — `POST
 *      /runs/:id/preview/teardown` (warren-d725) is the path. The worker
 *      filters on `preview_state IN ('starting','live')` so a row already
 *      transitioned to `torn-down` is naturally skipped on the next tick,
 *      and the per-row update re-reads state before writing to keep a
 *      racing manual-teardown idempotent at the SQL level.
 *
 * Common eviction action: best-effort `sidecars.delete` on burrow to stop
 * the long-lived `bun run dev` (etc.) process, `preview_state → torn-down`
 * + `preview_port → null` to release the port back to the allocator, and a
 * `preview_evicted` system event whose `reason` ∈ {`idle_ttl`,
 * `max_lifetime`, `lru`}. The **burrow workspace stays** — only the
 * preview process dies, so a re-launch (eg. R-12 future) is cheap.
 *
 * The worker is single-flight (mirrors `startScheduler` in
 * `src/triggers/tick.ts`): a tick in flight when the next interval fires
 * is skipped instead of stacking, so a slow tick degrades cadence but
 * never causes double eviction. Every observable side effect (clock,
 * sidecar client, sleeper, db, events) is injectable for tests.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import { ValidationError } from "../core/errors.ts";
import type { AnyWarrenDb, PostgresDrizzleDb, SqliteDrizzleDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PreviewState } from "../db/schema.ts";
import type { RunEventBroker } from "../runs/events.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { parseDurationMs } from "./duration.ts";
import type { PreviewSidecarsClient } from "./launch.ts";

/* ----------------------------------------------------------------------- */
/* Env config                                                               */
/* ----------------------------------------------------------------------- */

export const WARREN_PREVIEW_IDLE_TTL_ENV = "WARREN_PREVIEW_IDLE_TTL" as const;
export const WARREN_PREVIEW_MAX_LIFETIME_ENV = "WARREN_PREVIEW_MAX_LIFETIME" as const;
export const WARREN_PREVIEW_MAX_LIVE_ENV = "WARREN_PREVIEW_MAX_LIVE" as const;
export const WARREN_PREVIEW_EVICTION_TICK_MS_ENV = "WARREN_PREVIEW_EVICTION_TICK_MS" as const;
export const WARREN_PREVIEW_EVICTION_DISABLED_ENV = "WARREN_PREVIEW_EVICTION_DISABLED" as const;

/** SPEC §11.L: idle-TTL default 30 minutes. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
/** SPEC §11.L: max-lifetime default 8 hours. */
export const DEFAULT_MAX_LIFETIME_MS = 8 * 3_600_000;
/** SPEC §11.L: max live cap default 20. */
export const DEFAULT_MAX_LIVE = 20;
/** Default tick cadence; ~10s keeps responsiveness without hammering the db. */
export const DEFAULT_TICK_MS = 10_000;
/** `/readyz` saturation threshold for the live-count check. */
export const PREVIEW_MAX_LIVE_WARN_RATIO = 0.8;

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface PreviewEvictionConfig {
	readonly idleTtlMs: number;
	readonly maxLifetimeMs: number;
	readonly maxLive: number;
	readonly tickMs: number;
	readonly disabled: boolean;
}

/**
 * Resolve eviction config from env. Defaults match SPEC §11.L; malformed
 * values fail loudly at boot rather than silently degrading at tick time.
 */
export function loadPreviewEvictionConfigFromEnv(
	env: EnvLike = process.env,
): PreviewEvictionConfig {
	const idleTtlMs = parseEnvDuration(env, WARREN_PREVIEW_IDLE_TTL_ENV, DEFAULT_IDLE_TTL_MS);
	const maxLifetimeMs = parseEnvDuration(
		env,
		WARREN_PREVIEW_MAX_LIFETIME_ENV,
		DEFAULT_MAX_LIFETIME_MS,
	);
	const maxLive = parseEnvPositiveInt(env, WARREN_PREVIEW_MAX_LIVE_ENV, DEFAULT_MAX_LIVE);
	const tickMs = parseEnvPositiveInt(env, WARREN_PREVIEW_EVICTION_TICK_MS_ENV, DEFAULT_TICK_MS);
	const disabled = isTruthy(env[WARREN_PREVIEW_EVICTION_DISABLED_ENV]);
	return { idleTtlMs, maxLifetimeMs, maxLive, tickMs, disabled };
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
/* Tick implementation                                                       */
/* ----------------------------------------------------------------------- */

export type EvictionReason = "idle_ttl" | "max_lifetime" | "lru";

export interface PreviewEvictionLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Sidecar surface the worker needs from the burrow facade. Same `delete`
 * verb the launcher already uses; tests inject a fake that captures calls.
 */
export type SidecarClient = Pick<PreviewSidecarsClient, "delete"> & {
	list(burrowId: string): Promise<readonly { readonly id: string }[]>;
};

export type SidecarResolver = (burrowId: string) => Promise<SidecarClient | null>;

export interface RunPreviewRow {
	readonly runId: string;
	readonly projectId: string | null;
	readonly burrowId: string | null;
	readonly workerId: string | null;
	readonly previewState: "starting" | "live";
	readonly previewPort: number | null;
	readonly previewStartedAt: string | null;
	readonly previewLastHitAt: string | null;
}

/**
 * Outcome of a manual teardown CAS (warren-d725). The route returns the
 * shape verbatim in the response envelope so a client / UI can tell
 * "we just tore it down" apart from "it was already gone" without a
 * second round-trip — same posture as `cancelRun`'s `alreadyTerminal`
 * flag (mx-… cancel handler).
 *
 *   - `torn-down`        — was `starting`/`live`; CAS flipped it to
 *                          `torn-down`, port released. Caller emits a
 *                          `preview_torn_down` audit event.
 *   - `already-torn-down`— row was already `torn-down`; no event.
 *   - `already-failed`   — row is in terminal `failed` state. Port is
 *                          already null (set by the launcher on the
 *                          fail transition); no work needed, no event.
 *   - `never-launched`   — `preview_state` is null. The project never
 *                          opted in or reap's preview sub-step never
 *                          fired. No event.
 *
 * `previousState` mirrors the column the CAS read; `port` is the value
 * that was cleared (null when the row never carried one).
 */
export type ManualTeardownStatus =
	| "torn-down"
	| "already-torn-down"
	| "already-failed"
	| "never-launched";

export interface ManualTeardownClaim {
	readonly status: ManualTeardownStatus;
	readonly previousState: PreviewState | null;
	readonly port: number | null;
	readonly burrowId: string | null;
}

export interface RunPreviewsRepo {
	listActivePreviews(): Promise<readonly RunPreviewRow[]>;
	countActivePreviews(): Promise<number>;
	evict(input: {
		readonly runId: string;
		readonly reason: EvictionReason;
		readonly now: Date;
	}): Promise<boolean>;
	/**
	 * Atomically claim a `starting`/`live` preview for manual teardown
	 * (R-19 / SPEC §11.L acceptance #8, warren-d725). BEGIN IMMEDIATE
	 * serializes against the eviction worker's `evict` so a manual
	 * teardown racing an LRU sweep deterministically lands in exactly
	 * one of them — the loser sees `already-torn-down`. Returns the
	 * shape `teardownPreview` shapes onto the wire response and emits
	 * `preview_torn_down` against.
	 */
	claimTeardown(input: { readonly runId: string }): Promise<ManualTeardownClaim>;
}

export interface PreviewEvictionTickInput {
	readonly db: AnyWarrenDb;
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly warrenConfigs: WarrenConfigCache;
	readonly broker?: RunEventBroker;
	readonly config: PreviewEvictionConfig;
	readonly now?: () => Date;
	readonly logger?: PreviewEvictionLogger;
	/**
	 * Override the sidecar resolver (tests). Defaults to a pool-backed
	 * resolver that looks up the worker for `burrowId` and returns its
	 * `http.sidecars` facade. Returns `null` when the worker can't be
	 * resolved (e.g. the burrow row was deleted while the run was still
	 * carrying a stale `burrow_id`) so the eviction still runs db-side
	 * but the sidecar stop is skipped with a warning.
	 */
	readonly resolveSidecar?: SidecarResolver;
	/**
	 * Override the previews repo (tests). Defaults to a thin wrapper over
	 * `repos.runs` + drizzle. The CAS in `evict` is a single conditional
	 * UPDATE so a racing manual teardown is idempotent at the SQL layer.
	 */
	readonly previews?: RunPreviewsRepo;
}

export interface PreviewEvictionTickResult {
	readonly scanned: number;
	readonly evicted: ReadonlyArray<{ readonly runId: string; readonly reason: EvictionReason }>;
	readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
}

export async function runPreviewEvictionTick(
	input: PreviewEvictionTickInput,
): Promise<PreviewEvictionTickResult> {
	const now = input.now?.() ?? new Date();
	const previews = input.previews ?? createRunPreviewsRepo(input.db);
	const resolveSidecar = input.resolveSidecar ?? createPoolSidecarResolver(input.burrowClientPool);

	const rows = await previews.listActivePreviews();
	const evicted: { runId: string; reason: EvictionReason }[] = [];
	const skipped: { runId: string; reason: string }[] = [];
	const survivors: SurvivorRow[] = [];

	for (const row of rows) {
		const decision = await classifyRow({
			row,
			now,
			warrenConfigs: input.warrenConfigs,
			globalIdleTtlMs: input.config.idleTtlMs,
			globalMaxLifetimeMs: input.config.maxLifetimeMs,
			projectsRepo: input.repos.projects,
			logger: input.logger,
		});
		if (decision.kind === "evict") {
			await applyEviction({
				row,
				reason: decision.reason,
				now,
				resolveSidecar,
				previews,
				repos: input.repos,
				broker: input.broker,
				logger: input.logger,
				evicted,
				skipped,
			});
		} else {
			survivors.push({ row, idleSince: decision.idleSince });
		}
	}

	if (survivors.length > input.config.maxLive) {
		survivors.sort(compareIdleSinceAsc);
		const overflow = survivors.length - input.config.maxLive;
		for (let i = 0; i < overflow; i += 1) {
			const survivor = survivors[i];
			if (survivor === undefined) continue;
			await applyEviction({
				row: survivor.row,
				reason: "lru",
				now,
				resolveSidecar,
				previews,
				repos: input.repos,
				broker: input.broker,
				logger: input.logger,
				evicted,
				skipped,
			});
		}
	}

	return { scanned: rows.length, evicted, skipped };
}

interface SurvivorRow {
	readonly row: RunPreviewRow;
	/** Effective idle clock (last hit, falling back to started_at). */
	readonly idleSince: number;
}

function compareIdleSinceAsc(a: SurvivorRow, b: SurvivorRow): number {
	return a.idleSince - b.idleSince;
}

type RowDecision = { kind: "keep"; idleSince: number } | { kind: "evict"; reason: EvictionReason };

interface ClassifyInput {
	readonly row: RunPreviewRow;
	readonly now: Date;
	readonly warrenConfigs: WarrenConfigCache;
	readonly globalIdleTtlMs: number;
	readonly globalMaxLifetimeMs: number;
	readonly projectsRepo: Repos["projects"];
	readonly logger?: PreviewEvictionLogger;
}

async function classifyRow(input: ClassifyInput): Promise<RowDecision> {
	const nowMs = input.now.getTime();
	const startedMs = input.row.previewStartedAt
		? Date.parse(input.row.previewStartedAt)
		: Number.NaN;
	const lastHitMs = input.row.previewLastHitAt
		? Date.parse(input.row.previewLastHitAt)
		: Number.NaN;

	// Idle clock falls back to started_at when the row hasn't been hit yet;
	// otherwise a `live` preview that no one ever visits stays alive
	// forever despite the operator opting into idle eviction.
	const idleSinceMs = Number.isFinite(lastHitMs)
		? lastHitMs
		: Number.isFinite(startedMs)
			? startedMs
			: nowMs;

	const projectOverrides = await loadProjectOverrides(input);

	const maxLifetimeMs = projectOverrides.maxLifetimeMs ?? input.globalMaxLifetimeMs;
	if (Number.isFinite(startedMs) && nowMs - startedMs > maxLifetimeMs) {
		return { kind: "evict", reason: "max_lifetime" };
	}

	const idleTtlMs = projectOverrides.idleTtlMs ?? input.globalIdleTtlMs;
	if (nowMs - idleSinceMs > idleTtlMs) {
		return { kind: "evict", reason: "idle_ttl" };
	}

	return { kind: "keep", idleSince: idleSinceMs };
}

async function loadProjectOverrides(
	input: ClassifyInput,
): Promise<{ idleTtlMs?: number; maxLifetimeMs?: number }> {
	if (input.row.projectId === null) return {};
	const project = await input.projectsRepo.get(input.row.projectId);
	if (project === null) return {};
	let loaded: Awaited<ReturnType<WarrenConfigCache["get"]>>;
	try {
		loaded = await input.warrenConfigs.get(project.id, project.localPath);
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.row.runId,
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.warren_config_load_failed",
		);
		return {};
	}
	const preview = loaded.defaults?.preview;
	if (preview === undefined || preview.type !== "server") return {};
	const out: { idleTtlMs?: number; maxLifetimeMs?: number } = {};
	if (preview.idle_ttl !== undefined) {
		try {
			out.idleTtlMs = parseDurationMs(preview.idle_ttl);
		} catch (err) {
			input.logger?.warn(
				{
					runId: input.row.runId,
					projectId: project.id,
					value: preview.idle_ttl,
					err: err instanceof Error ? err.message : String(err),
				},
				"preview_eviction.idle_ttl_parse_failed",
			);
		}
	}
	if (preview.max_lifetime !== undefined) {
		try {
			out.maxLifetimeMs = parseDurationMs(preview.max_lifetime);
		} catch (err) {
			input.logger?.warn(
				{
					runId: input.row.runId,
					projectId: project.id,
					value: preview.max_lifetime,
					err: err instanceof Error ? err.message : String(err),
				},
				"preview_eviction.max_lifetime_parse_failed",
			);
		}
	}
	return out;
}

interface ApplyEvictionInput {
	readonly row: RunPreviewRow;
	readonly reason: EvictionReason;
	readonly now: Date;
	readonly resolveSidecar: SidecarResolver;
	readonly previews: RunPreviewsRepo;
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	readonly logger?: PreviewEvictionLogger;
	readonly evicted: Array<{ runId: string; reason: EvictionReason }>;
	readonly skipped: Array<{ runId: string; reason: string }>;
}

async function applyEviction(input: ApplyEvictionInput): Promise<void> {
	const claimed = await input.previews.evict({
		runId: input.row.runId,
		reason: input.reason,
		now: input.now,
	});
	if (!claimed) {
		// Lost the race against another writer (manual teardown, retry).
		input.skipped.push({ runId: input.row.runId, reason: "state_changed" });
		return;
	}

	if (input.row.burrowId !== null) {
		try {
			const sidecars = await input.resolveSidecar(input.row.burrowId);
			if (sidecars === null) {
				input.logger?.warn(
					{ runId: input.row.runId, burrowId: input.row.burrowId },
					"preview_eviction.sidecar_resolver_returned_null",
				);
			} else {
				const list = await sidecars.list(input.row.burrowId);
				for (const sc of list) {
					try {
						await sidecars.delete(input.row.burrowId, sc.id);
					} catch (err) {
						input.logger?.warn(
							{
								runId: input.row.runId,
								burrowId: input.row.burrowId,
								sidecarId: sc.id,
								err: err instanceof Error ? err.message : String(err),
							},
							"preview_eviction.sidecar_delete_failed",
						);
					}
				}
			}
		} catch (err) {
			input.logger?.warn(
				{
					runId: input.row.runId,
					burrowId: input.row.burrowId,
					err: err instanceof Error ? err.message : String(err),
				},
				"preview_eviction.sidecar_stop_failed",
			);
		}
	}

	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.row.runId)) ?? 0) + 1;
		const event = await input.repos.events.append({
			runId: input.row.runId,
			burrowEventSeq: seq,
			ts: input.now.toISOString(),
			kind: "preview_evicted",
			stream: "system",
			payload: {
				reason: input.reason,
				port: input.row.previewPort,
				previousState: input.row.previewState,
			},
		});
		input.broker?.publish(input.row.runId, event);
	} catch (err) {
		input.logger?.error(
			{
				runId: input.row.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.event_emit_failed",
		);
	}

	input.evicted.push({ runId: input.row.runId, reason: input.reason });
	input.logger?.info(
		{
			runId: input.row.runId,
			reason: input.reason,
			port: input.row.previewPort,
			previousState: input.row.previewState,
		},
		"preview_evicted",
	);
}

/* ----------------------------------------------------------------------- */
/* Drizzle-backed previews repo                                              */
/* ----------------------------------------------------------------------- */

/**
 * Construct a dialect-polymorphic previews repo over either sqlite or pg
 * (warren-adfb). Concurrency strategy:
 *
 *   - **`evict`** is a single CAS UPDATE...WHERE state IN ('starting','live')
 *     with `.returning({id})`. Atomic at the SQL layer on both dialects, so
 *     two concurrent evicters (or an evicter racing a manual teardown) can't
 *     both succeed: the second sees zero RETURNING rows and reports
 *     `claimed=false`. No transaction needed.
 *
 *   - **`claimTeardown`** must report the *previous* state (torn-down vs.
 *     already-torn-down vs. already-failed vs. never-launched), so it does
 *     SELECT-then-UPDATE inside a tx. The pg branch grabs `SELECT ... FOR
 *     UPDATE` on the candidate row to serialize against another claimer or
 *     the eviction worker; sqlite single-connection naturally serializes
 *     within one process, and warren only ever opens one writer connection.
 *     The UPDATE keeps a `state IN ('starting','live')` filter as a belt-
 *     and-suspenders CAS so even a concurrent evict that beats us to the
 *     row is correctly observed (the SELECT we did before still tells us
 *     `previousState`, but the UPDATE no-ops and we still return the right
 *     shape).
 */
export function createRunPreviewsRepo(db: AnyWarrenDb): RunPreviewsRepo {
	const adapter = DrizzleAdapter.for(db);
	const runs = adapter.schema.runs;
	const drizzleDb = adapter.drizzle as SqliteDrizzleDb;

	return {
		async listActivePreviews(): Promise<readonly RunPreviewRow[]> {
			const rows = await adapter.pickAll<{
				runId: string;
				projectId: string | null;
				burrowId: string | null;
				workerId: string | null;
				previewState: PreviewState | null;
				previewPort: number | null;
				previewStartedAt: string | null;
				previewLastHitAt: string | null;
			}>(
				drizzleDb
					.select({
						runId: runs.id,
						projectId: runs.projectId,
						burrowId: runs.burrowId,
						workerId: runs.workerId,
						previewState: runs.previewState,
						previewPort: runs.previewPort,
						previewStartedAt: runs.previewStartedAt,
						previewLastHitAt: runs.previewLastHitAt,
					})
					.from(runs)
					.where(inArray(runs.previewState, ["starting", "live"]))
					.orderBy(asc(runs.id)),
			);
			return rows.map((r) => ({
				runId: r.runId,
				projectId: r.projectId,
				burrowId: r.burrowId,
				workerId: r.workerId,
				previewState: r.previewState as "starting" | "live",
				previewPort: r.previewPort,
				previewStartedAt: r.previewStartedAt,
				previewLastHitAt: r.previewLastHitAt,
			}));
		},
		async countActivePreviews(): Promise<number> {
			const row = await adapter.pickOne<{ n: number | string }>(
				drizzleDb
					.select({ n: sql<number>`count(*)` })
					.from(runs)
					.where(inArray(runs.previewState, ["starting", "live"])),
			);
			return Number(row?.n ?? 0);
		},
		async evict(input): Promise<boolean> {
			const updated = await adapter.runReturningAll<{ id: string }>(
				drizzleDb
					.update(runs)
					.set({ previewState: "torn-down", previewPort: null })
					.where(and(eq(runs.id, input.runId), inArray(runs.previewState, ["starting", "live"])))
					.returning({ id: runs.id }),
			);
			return updated.length > 0;
		},
		async claimTeardown(input): Promise<ManualTeardownClaim> {
			return adapter.runInTransaction(async (tx) => {
				const txRuns = tx.schema.runs;
				const txDb = tx.drizzle as SqliteDrizzleDb;

				if (tx.dialect === "postgres") {
					// `SELECT ... FOR UPDATE` locks the candidate row for the
					// duration of the tx so a concurrent claimer or the
					// eviction worker blocks until we commit / rollback. Lock
					// is released automatically on tx end. Hand-rolled SQL
					// because `.for("update")` is pg-only and the schema
					// reference would need a dialect-incorrect cast to type-
					// check against the pg drizzle handle.
					const pgDb = tx.drizzle as PostgresDrizzleDb;
					await pgDb.execute(sql`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`);
				}

				const current = await tx.pickOne<{
					previewState: PreviewState | null;
					previewPort: number | null;
					burrowId: string | null;
				}>(
					txDb
						.select({
							previewState: txRuns.previewState,
							previewPort: txRuns.previewPort,
							burrowId: txRuns.burrowId,
						})
						.from(txRuns)
						.where(eq(txRuns.id, input.runId)),
				);
				if (current === undefined) {
					// `teardownPreview` already calls `repos.runs.require` before us,
					// so a row vanishing between that check and this transaction is
					// a deletion race the route surfaces as `never-launched` rather
					// than re-raising 404 from inside a transaction.
					return {
						status: "never-launched",
						previousState: null,
						port: null,
						burrowId: null,
					};
				}
				const previousState = current.previewState;
				if (previousState === "starting" || previousState === "live") {
					await tx.runWrite(
						txDb
							.update(txRuns)
							.set({ previewState: "torn-down", previewPort: null })
							.where(
								and(eq(txRuns.id, input.runId), inArray(txRuns.previewState, ["starting", "live"])),
							),
					);
					return {
						status: "torn-down",
						previousState,
						port: current.previewPort,
						burrowId: current.burrowId,
					};
				}
				if (previousState === "torn-down") {
					return {
						status: "already-torn-down",
						previousState,
						port: current.previewPort,
						burrowId: current.burrowId,
					};
				}
				if (previousState === "failed") {
					return {
						status: "already-failed",
						previousState,
						port: current.previewPort,
						burrowId: current.burrowId,
					};
				}
				return {
					status: "never-launched",
					previousState: null,
					port: current.previewPort,
					burrowId: current.burrowId,
				};
			});
		},
	};
}

/* ----------------------------------------------------------------------- */
/* Pool-backed sidecar resolver                                              */
/* ----------------------------------------------------------------------- */

export function createPoolSidecarResolver(pool: BurrowClientPool): SidecarResolver {
	return async (burrowId: string): Promise<SidecarClient | null> => {
		try {
			const placement = await pool.clientFor({ burrowId });
			const facade = placement.client.http.sidecars;
			return {
				list: (id) => facade.list(id),
				delete: (id, scid) => facade.delete(id, scid),
			};
		} catch {
			return null;
		}
	};
}

/* ----------------------------------------------------------------------- */
/* Periodic worker (start/stop)                                              */
/* ----------------------------------------------------------------------- */

export type EvictionTimerHandle = object;

export interface PreviewEvictionWorkerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously and await completion. */
	runOnce(): Promise<PreviewEvictionTickResult | null>;
	/** Test/diagnostic surface — completed tick count. */
	tickCount(): number;
}

export interface StartPreviewEvictionWorkerInput extends Omit<PreviewEvictionTickInput, "now"> {
	readonly now?: () => Date;
	readonly setInterval?: (cb: () => void, ms: number) => EvictionTimerHandle;
	readonly clearInterval?: (handle: EvictionTimerHandle) => void;
}

const NOOP_HANDLE = Symbol("preview-eviction-noop") as unknown as EvictionTimerHandle;

/**
 * Boot the eviction tick. Mirrors `startScheduler`'s contract: single-flight
 * (overlapping ticks are dropped, not stacked), `stop()` awaits the in-flight
 * tick to drain so a teardown doesn't race the next sidecar.delete.
 */
export function startPreviewEvictionWorker(
	input: StartPreviewEvictionWorkerInput,
): PreviewEvictionWorkerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => EvictionTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as EvictionTimerHandle);
	const clearIntervalFn: (handle: EvictionTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<PreviewEvictionTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<PreviewEvictionTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "preview_eviction.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runPreviewEvictionTick({
					db: input.db,
					repos: input.repos,
					burrowClientPool: input.burrowClientPool,
					warrenConfigs: input.warrenConfigs,
					config: input.config,
					...(input.broker !== undefined ? { broker: input.broker } : {}),
					...(input.now !== undefined ? { now: input.now } : {}),
					...(input.logger !== undefined ? { logger: input.logger } : {}),
					...(input.resolveSidecar !== undefined ? { resolveSidecar: input.resolveSidecar } : {}),
					...(input.previews !== undefined ? { previews: input.previews } : {}),
				});
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"preview_eviction.tick_failed",
				);
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: EvictionTimerHandle = input.config.disabled
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
					// Already logged inside fire().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
