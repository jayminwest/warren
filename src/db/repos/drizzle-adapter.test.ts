/**
 * Unit tests for the dialect-polymorphic drizzle adapter (R-13, pl-f1be step 1).
 *
 * Two describe blocks cover the dispatch matrix: sqlite always runs, postgres
 * runs only when `WARREN_TEST_PG_URL` is configured. The blocks are
 * intentionally parallel — same scenarios, dialect-specific schema imports —
 * so dialect-specific behavior (sqlite's BEGIN/COMMIT raw-exec path vs pg's
 * drizzle.transaction delegation; sqlite's TEXT-mode JSON serialization vs
 * pg's jsonb passthrough) is exercised against the actual drizzle internals
 * for each dialect. The duplication is meaningful: drizzle's union types
 * don't admit shared query-building code, and a dialect-correct table object
 * has to be paired with a dialect-correct drizzle handle at runtime
 * (mx-655320: pg jsonb rejects the stringified JSON sqlite's text-mode JSON
 * column emits).
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as pgSchema from "../schema/postgres.ts";
import * as sqliteSchema from "../schema/sqlite.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";

const ts = "2026-05-14T00:00:00.000Z";

describe("DrizzleAdapter (sqlite)", () => {
	test("for() preserves dialect and drizzle handle", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		expect(adapter.dialect).toBe("sqlite");
		expect(adapter.drizzle).toBe(handle.db.drizzle);
	});

	test("runWrite + pickOne round-trip a row", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		await adapter.runWrite(
			db.insert(agents).values({
				name: "claude-code",
				renderedJson: { agent: "claude-code" },
				registeredAt: ts,
				lastRefreshed: ts,
			}),
		);
		const row = await adapter.pickOne(
			db.select().from(agents).where(eq(agents.name, "claude-code")),
		);
		expect(row?.name).toBe("claude-code");
	});

	test("pickOne returns undefined when the row is absent", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		const row = await adapter.pickOne(db.select().from(agents).where(eq(agents.name, "missing")));
		expect(row).toBeUndefined();
	});

	test("pickAll returns inserted rows", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		for (const name of ["alpha", "mango", "zebra"]) {
			await adapter.runWrite(
				db.insert(agents).values({
					name,
					renderedJson: { agent: name },
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
		}
		const rows = await adapter.pickAll(db.select().from(agents));
		expect(rows.map((r) => r.name).sort()).toEqual(["alpha", "mango", "zebra"]);
	});

	test("runReturningOne yields the inserted row's server-side defaults", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents, projects, runs, events } = sqliteSchema;
		const db = handle.db.drizzle;

		await adapter.runWrite(
			db.insert(agents).values({
				name: "claude-code",
				renderedJson: {},
				registeredAt: ts,
				lastRefreshed: ts,
			}),
		);
		await adapter.runWrite(
			db.insert(projects).values({
				id: "proj_test",
				gitUrl: "https://example.invalid/repo.git",
				localPath: "/tmp/repo",
				defaultBranch: "main",
				addedAt: ts,
				lastFetchedAt: null,
				lastHeadSha: null,
			}),
		);
		await adapter.runWrite(
			db.insert(runs).values({
				id: "run_test",
				agentName: "claude-code",
				projectId: "proj_test",
				sandboxId: null,
				sandboxRunId: null,
				workerId: null,
				renderedAgentJson: {},
				state: "queued",
				failureReason: null,
				startedAt: null,
				endedAt: null,
				prompt: "noop",
				trigger: "manual",
				prUrl: null,
				costUsd: null,
				tokensInput: null,
				tokensOutput: null,
				tokensCacheRead: null,
				tokensCacheWrite: null,
				previewState: null,
				previewPort: null,
				previewStartedAt: null,
				previewLastHitAt: null,
				previewFailureMessage: null,
			}),
		);
		const inserted = await adapter.runReturningOne(
			db
				.insert(events)
				.values({
					runId: "run_test",
					sandboxEventSeq: 1,
					ts,
					kind: "test",
					stream: null,
					payloadJson: { hello: "world" },
				})
				.returning(),
		);
		expect(typeof inserted.id).toBe("number");
		expect(inserted.id).toBeGreaterThan(0);
	});

	test("runReturningOne throws when no rows came back", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		await expect(
			adapter.runReturningOne(
				db
					.update(agents)
					.set({ lastRefreshed: ts })
					.where(eq(agents.name, "nonexistent"))
					.returning(),
			),
		).rejects.toThrow(/returned no rows/);
	});

	test("runInTransaction commits when fn returns", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		await adapter.runInTransaction(async (tx) => {
			expect(tx.dialect).toBe("sqlite");
			await tx.runWrite(
				db.insert(agents).values({
					name: "in-tx",
					renderedJson: {},
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
		});
		const row = await adapter.pickOne(db.select().from(agents).where(eq(agents.name, "in-tx")));
		expect(row?.name).toBe("in-tx");
	});

	test("runInTransaction rolls back when fn throws", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		await expect(
			adapter.runInTransaction(async (tx) => {
				await tx.runWrite(
					db.insert(agents).values({
						name: "rolled-back",
						renderedJson: {},
						registeredAt: ts,
						lastRefreshed: ts,
					}),
				);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const row = await adapter.pickOne(
			db.select().from(agents).where(eq(agents.name, "rolled-back")),
		);
		expect(row).toBeUndefined();
	});

	test("runInTransaction reads its own writes through the tx adapter", async () => {
		await using handle = await withDb({ dialect: "sqlite" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = sqliteSchema;
		const db = handle.db.drizzle;

		const observed = await adapter.runInTransaction(async (tx) => {
			await tx.runWrite(
				db.insert(agents).values({
					name: "read-own-write",
					renderedJson: { v: 1 },
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
			return tx.pickOne(db.select().from(agents).where(eq(agents.name, "read-own-write")));
		});
		expect(observed?.name).toBe("read-own-write");
	});
});

describe.skipIf(!isPostgresTestEnabled())("DrizzleAdapter (postgres)", () => {
	test("for() preserves dialect and drizzle handle", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		expect(adapter.dialect).toBe("postgres");
		expect(adapter.drizzle).toBe(handle.db.drizzle);
	});

	test("runWrite + pickOne round-trip a row", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const db = handle.db.drizzle;

		await adapter.runWrite(
			db.insert(agents).values({
				name: "claude-code",
				renderedJson: { agent: "claude-code" },
				registeredAt: ts,
				lastRefreshed: ts,
			}),
		);
		const row = await adapter.pickOne(
			db.select().from(agents).where(eq(agents.name, "claude-code")),
		);
		expect(row?.name).toBe("claude-code");
	});

	test("pickOne returns undefined when the row is absent", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const db = handle.db.drizzle;

		const row = await adapter.pickOne(db.select().from(agents).where(eq(agents.name, "missing")));
		expect(row).toBeUndefined();
	});

	test("pickAll returns inserted rows", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const db = handle.db.drizzle;

		for (const name of ["alpha", "mango", "zebra"]) {
			await adapter.runWrite(
				db.insert(agents).values({
					name,
					renderedJson: { agent: name },
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
		}
		const rows = await adapter.pickAll(db.select().from(agents));
		expect(rows.map((r) => r.name).sort()).toEqual(["alpha", "mango", "zebra"]);
	});

	test("runReturningOne yields the inserted row's server-side defaults", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents, projects, runs, events } = pgSchema;
		const db = handle.db.drizzle;

		await adapter.runWrite(
			db.insert(agents).values({
				name: "claude-code",
				renderedJson: {},
				registeredAt: ts,
				lastRefreshed: ts,
			}),
		);
		await adapter.runWrite(
			db.insert(projects).values({
				id: "proj_test",
				gitUrl: "https://example.invalid/repo.git",
				localPath: "/tmp/repo",
				defaultBranch: "main",
				addedAt: ts,
				lastFetchedAt: null,
				lastHeadSha: null,
			}),
		);
		await adapter.runWrite(
			db.insert(runs).values({
				id: "run_test",
				agentName: "claude-code",
				projectId: "proj_test",
				sandboxId: null,
				sandboxRunId: null,
				workerId: null,
				renderedAgentJson: {},
				state: "queued",
				failureReason: null,
				startedAt: null,
				endedAt: null,
				prompt: "noop",
				trigger: "manual",
				prUrl: null,
				costUsd: null,
				tokensInput: null,
				tokensOutput: null,
				tokensCacheRead: null,
				tokensCacheWrite: null,
				previewState: null,
				previewPort: null,
				previewStartedAt: null,
				previewLastHitAt: null,
				previewFailureMessage: null,
			}),
		);
		const inserted = await adapter.runReturningOne(
			db
				.insert(events)
				.values({
					runId: "run_test",
					sandboxEventSeq: 1,
					ts,
					kind: "test",
					stream: null,
					payloadJson: { hello: "world" },
				})
				.returning(),
		);
		expect(typeof inserted.id).toBe("number");
		expect(inserted.id).toBeGreaterThan(0);
	});

	test("runReturningOne throws when no rows came back", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const db = handle.db.drizzle;

		await expect(
			adapter.runReturningOne(
				db
					.update(agents)
					.set({ lastRefreshed: ts })
					.where(eq(agents.name, "nonexistent"))
					.returning(),
			),
		).rejects.toThrow(/returned no rows/);
	});

	test("runInTransaction commits when fn returns; the tx adapter is pg-scoped", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const outerDb = handle.db.drizzle;

		await adapter.runInTransaction(async (tx) => {
			expect(tx.dialect).toBe("postgres");
			// The tx-scoped drizzle handle is NOT the top-level db — drizzle's
			// pg transaction passes a NodePgTransaction that issues SQL inside
			// the open BEGIN.
			expect(tx.drizzle).not.toBe(outerDb);
			const txDb = tx.drizzle as typeof outerDb;
			await tx.runWrite(
				txDb.insert(agents).values({
					name: "in-tx",
					renderedJson: {},
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
		});
		const row = await adapter.pickOne(
			outerDb.select().from(agents).where(eq(agents.name, "in-tx")),
		);
		expect(row?.name).toBe("in-tx");
	});

	test("runInTransaction rolls back when fn throws", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const outerDb = handle.db.drizzle;

		await expect(
			adapter.runInTransaction(async (tx) => {
				const txDb = tx.drizzle as typeof outerDb;
				await tx.runWrite(
					txDb.insert(agents).values({
						name: "rolled-back",
						renderedJson: {},
						registeredAt: ts,
						lastRefreshed: ts,
					}),
				);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const row = await adapter.pickOne(
			outerDb.select().from(agents).where(eq(agents.name, "rolled-back")),
		);
		expect(row).toBeUndefined();
	});

	test("runInTransaction reads its own writes through the tx adapter", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const adapter = DrizzleAdapter.for(handle.db);
		const { agents } = pgSchema;
		const outerDb = handle.db.drizzle;

		const observed = await adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as typeof outerDb;
			await tx.runWrite(
				txDb.insert(agents).values({
					name: "read-own-write",
					renderedJson: { v: 1 },
					registeredAt: ts,
					lastRefreshed: ts,
				}),
			);
			return tx.pickOne(txDb.select().from(agents).where(eq(agents.name, "read-own-write")));
		});
		expect(observed?.name).toBe("read-own-write");
	});
});
