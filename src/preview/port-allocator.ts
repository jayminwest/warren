/**
 * Dialect-polymorphic preview port allocator (R-19 / docs/design/preview-environments.md, warren-2277;
 * dialect-aware port via warren-adfb).
 *
 * Picks a free TCP port from a configurable range and claims it by writing
 * `runs.preview_port` + `runs.preview_state='starting'` + `runs.preview_started_at`
 * to the candidate run row, atomically. The runs table is the **only**
 * source-of-truth — there is no separate `ports` table and no in-memory
 * "released" set. Restart-safety falls out for free: a fresh allocator on
 * the same database sees the in-use set by querying
 *
 *   SELECT preview_port FROM runs
 *    WHERE preview_state IN ('starting','live') AND preview_port IS NOT NULL
 *
 * which the eviction worker (`pl-2c59` step 7) and the manual teardown
 * route already keep current. A torn-down or failed run that still carries
 * a stale `preview_port` is naturally excluded by the state filter.
 *
 * **Concurrency.** Two layers of serialization keep allocations correct:
 *
 *   1. **In-process Promise-chain mutex** — `allocateChain` serializes all
 *      `allocate()` calls within a single warren process. SQLite holds one
 *      connection per `WarrenDb`, so two parallel allocators would otherwise
 *      hit "cannot start a transaction within a transaction" when the second
 *      `BEGIN` lands while the first tx body is mid-`await`. The mutex also
 *      makes the snapshot-then-pick-then-write sequence indivisible per
 *      process so two concurrent allocate() calls can't race the same port.
 *
 *   2. **Postgres advisory lock** — inside the tx the pg branch grabs
 *      `pg_advisory_xact_lock(PG_ADVISORY_LOCK_KEY)`, which serializes
 *      allocators *across* warren processes / replicas sharing one db.
 *      Auto-released on commit/rollback. Same semantic the SQLite branch
 *      gets implicitly from the single-process mutex (sqlite is single-
 *      writer per process; warren only ever opens one writer connection).
 *
 * **Exhaustion.** Returns `{ status: 'exhausted' }` instead of throwing.
 * The reap-time launch sub-step (warren-f156) translates that into a
 * `preview_failed` event with `reason='port_exhausted'` per docs/design/preview-environments.md.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { PostgresDrizzleDb, SqliteDrizzleDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";

export const WARREN_PREVIEW_PORT_RANGE_ENV = "WARREN_PREVIEW_PORT_RANGE" as const;

export interface PortRange {
	/** Inclusive lower bound. */
	readonly start: number;
	/** Inclusive upper bound. */
	readonly end: number;
}

export const DEFAULT_PREVIEW_PORT_RANGE: PortRange = { start: 30000, end: 31000 };

/** Saturation threshold doctor uses to flip the warning. */
export const PREVIEW_PORT_USAGE_WARN_RATIO = 0.8;

/** Reason value the reap-time launch sub-step emits on exhaustion. */
export const PORT_EXHAUSTED_REASON = "port_exhausted" as const;

/**
 * Constant key for `pg_advisory_xact_lock` — serializes all preview port
 * allocations across pg processes against one database. Picked once and
 * stable: changing it during a rolling deploy would let an old- and new-
 * version allocator race on the same port range. Postgres advisory locks
 * share a single namespace per db; this value is a positive int8 chosen
 * to avoid trivial collisions with other potential warren locks.
 */
const PG_ADVISORY_LOCK_KEY = 5710638504754n;

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type AllocateOutcome =
	| { readonly status: "allocated"; readonly port: number }
	| { readonly status: "exhausted" };

export interface PortUsage {
	readonly inUse: number;
	readonly total: number;
	readonly range: PortRange;
}

/**
 * Parse a `"<start>-<end>"` range literal. Both bounds inclusive. Throws
 * `ValidationError` with a recovery hint on any malformed input so the
 * doctor surface can render a clear operator message.
 */
export function parsePortRange(raw: string): PortRange {
	const trimmed = raw.trim();
	const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
	if (!match) {
		throw new ValidationError(`port range must be "<start>-<end>" (got ${JSON.stringify(raw)})`, {
			recoveryHint: `example: ${DEFAULT_PREVIEW_PORT_RANGE.start}-${DEFAULT_PREVIEW_PORT_RANGE.end}`,
		});
	}
	const start = Number.parseInt(match[1] as string, 10);
	const end = Number.parseInt(match[2] as string, 10);
	if (!isValidPort(start) || !isValidPort(end)) {
		throw new ValidationError(`port range bounds must be integers 1..65535 (got ${start}-${end})`);
	}
	if (start > end) {
		throw new ValidationError(`port range start (${start}) must be <= end (${end})`, {
			recoveryHint: "swap the bounds or widen the range",
		});
	}
	return { start, end };
}

/**
 * Resolve the effective port range from the environment. Unset / empty
 * value falls back to `DEFAULT_PREVIEW_PORT_RANGE`. Malformed values
 * throw so an operator typo surfaces at boot rather than as a confusing
 * exhaustion later.
 */
export function loadPreviewPortRangeFromEnv(env: EnvLike = process.env): PortRange {
	const raw = env[WARREN_PREVIEW_PORT_RANGE_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_PREVIEW_PORT_RANGE;
	return parsePortRange(raw);
}

/**
 * Compute total port count in the range (inclusive on both ends).
 */
export function rangeSize(range: PortRange): number {
	return range.end - range.start + 1;
}

function isValidPort(n: number): boolean {
	return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Atomic port allocator. One instance per warren process (per db); the
 * underlying storage is the runs table, so multiple instances against the
 * same db agree on the in-use set by construction.
 */
export class PreviewPortAllocator {
	/**
	 * Promise-chain mutex serializing concurrent `allocate()` calls within
	 * a single process. See module header for why: sqlite single-connection
	 * + async tx body would otherwise BEGIN-inside-BEGIN under Promise.all,
	 * and even on pg this prevents two concurrent picks from observing the
	 * same in-use snapshot.
	 */
	private allocateChain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly adapter: DrizzleAdapter,
		private readonly range: PortRange = DEFAULT_PREVIEW_PORT_RANGE,
	) {
		if (!isValidPort(range.start) || !isValidPort(range.end) || range.start > range.end) {
			throw new ValidationError(
				`PreviewPortAllocator range must be a valid inclusive port range (got ${range.start}-${range.end})`,
			);
		}
	}

	/** The configured port range (read-only). */
	get portRange(): PortRange {
		return this.range;
	}

	/**
	 * Atomically pick a free port and claim it on the given run row by
	 * writing `preview_port`, `preview_state='starting'`, and
	 * `preview_started_at`. Idempotent: if the run already holds a port
	 * in `starting`/`live`, returns that port unchanged.
	 *
	 * Throws `NotFoundError` if `runId` does not exist (caller has a
	 * structural bug — reap looks up the run row before calling here).
	 */
	async allocate(runId: string, now: Date = new Date()): Promise<AllocateOutcome> {
		const next = this.allocateChain.then(() => this.allocateOnce(runId, now));
		// Don't let a rejection from one allocation poison the chain for
		// subsequent calls — the rejection still surfaces on `next`.
		this.allocateChain = next.catch(() => undefined);
		return next;
	}

	private async allocateOnce(runId: string, now: Date): Promise<AllocateOutcome> {
		return this.adapter.runInTransaction(async (tx) => {
			if (tx.dialect === "postgres") {
				const pgDb = tx.drizzle as PostgresDrizzleDb;
				await pgDb.execute(sql`SELECT pg_advisory_xact_lock(${PG_ADVISORY_LOCK_KEY})`);
			}
			const runs = tx.schema.runs;
			const txDb = tx.drizzle as SqliteDrizzleDb;

			const current = await tx.pickOne<{
				previewPort: number | null;
				previewState: string | null;
			}>(
				txDb
					.select({
						previewPort: runs.previewPort,
						previewState: runs.previewState,
					})
					.from(runs)
					.where(eq(runs.id, runId)),
			);
			if (!current) {
				throw new NotFoundError(`run not found: ${runId}`);
			}

			if (
				current.previewPort !== null &&
				(current.previewState === "starting" || current.previewState === "live")
			) {
				return { status: "allocated", port: current.previewPort };
			}

			const inUse = await this.snapshotInUse(tx);
			const chosen = this.pickFreePort(inUse);
			if (chosen === null) {
				return { status: "exhausted" };
			}

			await tx.runWrite(
				txDb
					.update(runs)
					.set({
						previewPort: chosen,
						previewState: "starting",
						previewStartedAt: now.toISOString(),
					})
					.where(eq(runs.id, runId)),
			);

			return { status: "allocated", port: chosen };
		});
	}

	/**
	 * Snapshot port usage for `warren doctor` / `/readyz`. Cheap (one
	 * indexed SELECT). `inUse` counts unique ports currently held by
	 * `starting` or `live` runs; `total` is the configured range size.
	 */
	async usage(): Promise<PortUsage> {
		const inUse = await this.snapshotInUse(this.adapter);
		return { inUse: inUse.size, total: rangeSize(this.range), range: this.range };
	}

	private async snapshotInUse(scope: DrizzleAdapter): Promise<Set<number>> {
		const runs = scope.schema.runs;
		const txDb = scope.drizzle as SqliteDrizzleDb;
		const rows = await scope.pickAll<{ port: number | null }>(
			txDb
				.select({ port: runs.previewPort })
				.from(runs)
				.where(and(inArray(runs.previewState, ["starting", "live"]), isNotNull(runs.previewPort))),
		);
		const set = new Set<number>();
		for (const row of rows) {
			if (row.port !== null) set.add(row.port);
		}
		return set;
	}

	private pickFreePort(inUse: ReadonlySet<number>): number | null {
		for (let port = this.range.start; port <= this.range.end; port += 1) {
			if (!inUse.has(port)) return port;
		}
		return null;
	}
}
