/**
 * The campaign budget ledger (design record §8).
 *
 * `available = campaign_cap - settled_spend - active_reservations`. A
 * reservation is taken for the full per-run cap before dispatch; on
 * termination the actual recorded cost replaces it. An unknown cost keeps
 * its conservative reservation until an operator resolves it — settlement
 * never shrinks spend out of the ledger on a guess.
 */
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type { ReservationRow, ReservationState } from "./types.ts";

type ReservationDbRow = {
	id: string;
	campaign_id: string;
	action_id: string | null;
	amount_usd_cents: number;
	state: string;
	settled_usd_cents: number | null;
	created_at_ms: number;
	settled_at_ms: number | null;
};

function toReservation(row: ReservationDbRow): ReservationRow {
	return {
		id: row.id,
		campaignId: row.campaign_id,
		actionId: row.action_id,
		amountUsdCents: row.amount_usd_cents,
		state: row.state as ReservationState,
		settledUsdCents: row.settled_usd_cents,
		createdAtMs: row.created_at_ms,
		settledAtMs: row.settled_at_ms,
	};
}

export class BudgetStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/** Reserve `amountUsdCents` against the campaign cap. Fails closed. */
	reserve(input: {
		campaignId: string;
		actionId?: string | null;
		amountUsdCents: number;
	}): ReservationRow {
		if (input.amountUsdCents < 0) {
			throw new StateError("reservation amount must be non-negative");
		}
		const cap = this.#campaignCap(input.campaignId);
		const available = this.availableUsdCents(input.campaignId);
		if (input.amountUsdCents > available) {
			throw new StateError(
				`insufficient campaign budget: need ${input.amountUsdCents}c, ${available}c of ${cap}c available`,
			);
		}
		const id = this.#ctx.ids.newId();
		this.#ctx.db
			.query(
				`INSERT INTO budget_reservations (id, campaign_id, action_id, amount_usd_cents, state, created_at_ms)
				 VALUES (?, ?, ?, ?, 'active', ?)`,
			)
			.run(id, input.campaignId, input.actionId ?? null, input.amountUsdCents, nowMs(this.#ctx));
		return this.getReservation(id) as ReservationRow;
	}

	getReservation(id: string): ReservationRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM budget_reservations WHERE id = ?")
			.get(id) as ReservationDbRow | null;
		return row === null ? null : toReservation(row);
	}

	listReservations(campaignId: string): ReservationRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM budget_reservations WHERE campaign_id = ? ORDER BY created_at_ms, id")
			.all(campaignId) as ReservationDbRow[];
		return rows.map(toReservation);
	}

	/**
	 * Replace an active reservation with the actual terminal cost. The
	 * settled amount may exceed the reservation (the reservation only gated
	 * dispatch; the ledger records what was really spent).
	 */
	settleReservation(id: string, actualUsdCents: number): ReservationRow {
		this.#requireActive(id);
		if (actualUsdCents < 0) {
			throw new StateError("settled amount must be non-negative");
		}
		this.#ctx.db
			.query(
				"UPDATE budget_reservations SET state = 'settled', settled_usd_cents = ?, settled_at_ms = ? WHERE id = ?",
			)
			.run(actualUsdCents, nowMs(this.#ctx), id);
		return this.getReservation(id) as ReservationRow;
	}

	/**
	 * Release an active reservation without spend — the reserved action never
	 * reached I/O. An uncertain action must not be released on a guess; the
	 * operator resolves it explicitly.
	 */
	releaseReservation(id: string): ReservationRow {
		this.#requireActive(id);
		this.#ctx.db
			.query(
				"UPDATE budget_reservations SET state = 'released', settled_usd_cents = 0, settled_at_ms = ? WHERE id = ?",
			)
			.run(nowMs(this.#ctx), id);
		return this.getReservation(id) as ReservationRow;
	}

	/** The active-or-settled reservation attached to an action, if any. */
	getReservationByAction(actionId: string): ReservationRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM budget_reservations WHERE action_id = ? ORDER BY created_at_ms DESC")
			.get(actionId) as ReservationDbRow | null;
		return row === null ? null : toReservation(row);
	}

	/** Bind an existing reservation to the action it funds. */
	attachReservation(id: string, actionId: string): ReservationRow {
		const row = this.getReservation(id);
		if (row === null) throw new StateError(`unknown reservation: ${id}`);
		if (row.state !== "active") {
			throw new StateError(`reservation ${id} is ${row.state}; only active reservations attach`);
		}
		this.#ctx.db
			.query("UPDATE budget_reservations SET action_id = ? WHERE id = ?")
			.run(actionId, id);
		return this.getReservation(id) as ReservationRow;
	}

	/** cap − settled spend − active reservations. */
	availableUsdCents(campaignId: string): number {
		const cap = this.#campaignCap(campaignId);
		const row = this.#ctx.db
			.query(
				`SELECT
				 COALESCE(SUM(CASE WHEN state = 'settled' THEN settled_usd_cents ELSE 0 END), 0) AS spent,
				 COALESCE(SUM(CASE WHEN state = 'active' THEN amount_usd_cents ELSE 0 END), 0) AS reserved
				 FROM budget_reservations WHERE campaign_id = ?`,
			)
			.get(campaignId) as { spent: number; reserved: number };
		return cap - row.spent - row.reserved;
	}

	#campaignCap(campaignId: string): number {
		const row = this.#ctx.db
			.query("SELECT budget_cap_usd_cents FROM campaigns WHERE id = ?")
			.get(campaignId) as { budget_cap_usd_cents: number | null } | null;
		if (row === null) throw new StateError(`unknown campaign: ${campaignId}`);
		if (row.budget_cap_usd_cents === null) {
			throw new StateError(`campaign ${campaignId} has no budget cap; cannot reserve`);
		}
		return row.budget_cap_usd_cents;
	}

	#requireActive(id: string): void {
		const row = this.getReservation(id);
		if (row === null) throw new StateError(`unknown reservation: ${id}`);
		if (row.state !== "active") {
			throw new StateError(`reservation ${id} is ${row.state}; only active reservations settle`);
		}
	}
}
