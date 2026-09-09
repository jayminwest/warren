import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DispatchRow {
	issueId: string;
	projectId: string;
	state: "reserved" | "running" | "settled" | "uncertain" | "rejected";
	runId: string | null;
	reservedUsd: number;
	costUsd: number | null;
	createdAt: number;
	message: string | null;
}

/** One durable attempt per issue. Unknown POST outcomes are NEVER retried. */
export class DispatchStore {
	private readonly db: Database;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path, { create: true });
		chmodSync(path, 0o600);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS dispatches (
			 issueId TEXT PRIMARY KEY, projectId TEXT NOT NULL,
			 state TEXT NOT NULL CHECK(state IN ('reserved','running','settled','uncertain','rejected')),
			 runId TEXT, reservedUsd REAL NOT NULL, costUsd REAL, createdAt INTEGER NOT NULL, message TEXT
			)`);
	}

	list(): DispatchRow[] {
		return this.db
			.query<DispatchRow, []>("SELECT * FROM dispatches ORDER BY createdAt, issueId")
			.all();
	}

	reserve(
		issueId: string,
		projectId: string,
		cap: number,
		daily: number,
		maxConcurrent: number,
		now: number,
	): boolean {
		return this.db
			.transaction(() => {
				const existing = this.db.query("SELECT 1 FROM dispatches WHERE issueId=?").get(issueId);
				if (existing) return false;
				if (!this.hasCapacity(cap, daily, maxConcurrent, now)) return false;
				this.db
					.query(
						"INSERT INTO dispatches(issueId,projectId,state,reservedUsd,createdAt) VALUES(?,?,'reserved',?,?)",
					)
					.run(issueId, projectId, cap, now);
				return true;
			})
			.immediate();
	}

	hasCapacity(cap: number, daily: number, maxConcurrent: number, now: number): boolean {
		const unsafe = this.db.query("SELECT 1 FROM dispatches WHERE state='uncertain' LIMIT 1").get();
		if (unsafe) return false;
		const active =
			this.db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) n FROM dispatches WHERE state IN ('reserved','running','uncertain')",
				)
				.get()?.n ?? 0;
		if (active >= maxConcurrent) return false;
		const date = new Date(now);
		date.setUTCHours(0, 0, 0, 0);
		const spent =
			this.db
				.query<
					{ usd: number },
					[number]
				>(`SELECT COALESCE(SUM(MAX(reservedUsd, COALESCE(costUsd,0))),0) usd
				FROM dispatches WHERE (createdAt>=? OR state IN ('reserved','running','uncertain')) AND state!='rejected'`)
				.get(date.getTime())?.usd ?? 0;
		if (spent + cap > daily + 1e-9) return false;
		return true;
	}

	record(
		issueId: string,
		state: DispatchRow["state"],
		runId: string | null,
		message: string | null = null,
		costUsd: number | null = null,
	): void {
		this.db
			.query("UPDATE dispatches SET state=?,runId=?,message=?,costUsd=? WHERE issueId=?")
			.run(state, runId, message, costUsd, issueId);
	}

	close(): void {
		this.db.close();
	}
}
