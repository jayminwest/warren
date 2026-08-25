/**
 * Leased work claims (design record §9).
 *
 * One lease row per scope; acquiring over a live lease fails, acquiring over
 * an expired lease replaces it. `expireLeases` is the boot-time sweep the
 * reconciler runs before loading non-terminal campaigns.
 */
import { nowMs, type StoreContext } from "./context.ts";
import type { LeaseRow } from "./types.ts";

type LeaseDbRow = {
	scope: string;
	holder: string;
	acquired_at_ms: number;
	expires_at_ms: number;
};

function toLease(row: LeaseDbRow): LeaseRow {
	return {
		scope: row.scope,
		holder: row.holder,
		acquiredAtMs: row.acquired_at_ms,
		expiresAtMs: row.expires_at_ms,
	};
}

export class LeaseStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/**
	 * Claim `scope` for `holder` for `ttlMs`. Returns the lease, or null when
	 * another holder holds an unexpired lease. Expired leases are reassignable.
	 */
	acquireLease(scope: string, holder: string, ttlMs: number): LeaseRow | null {
		const now = nowMs(this.#ctx);
		const existing = this.getLease(scope);
		if (existing !== null && existing.expiresAtMs > now && existing.holder !== holder) {
			return null;
		}
		if (existing !== null && existing.holder === holder && existing.expiresAtMs > now) {
			return existing;
		}
		this.#ctx.db
			.query(
				`INSERT INTO leases (scope, holder, acquired_at_ms, expires_at_ms)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(scope) DO UPDATE SET
					holder = excluded.holder,
					acquired_at_ms = excluded.acquired_at_ms,
					expires_at_ms = excluded.expires_at_ms`,
			)
			.run(scope, holder, now, now + ttlMs);
		return this.getLease(scope);
	}

	getLease(scope: string): LeaseRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM leases WHERE scope = ?")
			.get(scope) as LeaseDbRow | null;
		return row === null ? null : toLease(row);
	}

	/** Release a lease. Only the current holder may release it. */
	releaseLease(scope: string, holder: string): boolean {
		const result = this.#ctx.db
			.query("DELETE FROM leases WHERE scope = ? AND holder = ?")
			.run(scope, holder);
		return result.changes === 1;
	}

	/** Drop every expired lease; returns how many were removed. */
	expireLeases(): number {
		const result = this.#ctx.db
			.query("DELETE FROM leases WHERE expires_at_ms <= ?")
			.run(nowMs(this.#ctx));
		return result.changes;
	}

	listLeases(): LeaseRow[] {
		const rows = this.#ctx.db.query("SELECT * FROM leases ORDER BY scope").all() as LeaseDbRow[];
		return rows.map(toLease);
	}
}
