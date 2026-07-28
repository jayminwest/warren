import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../core/errors.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`AgentsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const repo = new AgentsRepo(adapter);
			return { handle, repo };
		};

		test("upsert inserts a new row with both timestamps equal", async () => {
			const { handle, repo } = await open();
			try {
				const now = new Date("2026-05-08T12:00:00.000Z");
				const row = await repo.upsert({
					name: "refactor-bot",
					renderedJson: { sections: { system: "..." } },
					now,
				});
				expect(row.name).toBe("refactor-bot");
				expect(row.registeredAt).toBe(now.toISOString());
				expect(row.lastRefreshed).toBe(now.toISOString());
				expect(row.renderedJson).toEqual({ sections: { system: "..." } });
			} finally {
				await handle.close();
			}
		});

		test("upsert on an existing row preserves registeredAt and bumps lastRefreshed", async () => {
			const { handle, repo } = await open();
			try {
				const t0 = new Date("2026-05-08T12:00:00.000Z");
				const t1 = new Date("2026-05-09T12:00:00.000Z");
				await repo.upsert({ name: "refactor-bot", renderedJson: { v: 1 }, now: t0 });
				const row = await repo.upsert({ name: "refactor-bot", renderedJson: { v: 2 }, now: t1 });
				expect(row.registeredAt).toBe(t0.toISOString());
				expect(row.lastRefreshed).toBe(t1.toISOString());
				expect(row.renderedJson).toEqual({ v: 2 });
			} finally {
				await handle.close();
			}
		});

		test("get returns null for unknown names; require throws NotFoundError", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.get("missing")).toBeNull();
				expect(repo.require("missing")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listAll returns rows alphabetically by name", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "zebra", renderedJson: {} });
				await repo.upsert({ name: "alpha", renderedJson: {} });
				await repo.upsert({ name: "mango", renderedJson: {} });
				expect((await repo.listAll()).map((r) => r.name)).toEqual(["alpha", "mango", "zebra"]);
			} finally {
				await handle.close();
			}
		});

		test("delete removes the row", async () => {
			const { handle, repo } = await open();
			try {
				await repo.upsert({ name: "refactor-bot", renderedJson: {} });
				await repo.delete("refactor-bot");
				expect(await repo.get("refactor-bot")).toBeNull();
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) {
	suite("postgres");
}
