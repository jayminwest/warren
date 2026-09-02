import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`EventsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const events = new EventsRepo(adapter);
			await agents.upsert({ name: "refactor-bot", renderedJson: {} });
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const run = await runs.create({
				agentName: "refactor-bot",
				projectId: project.id,
				renderedAgentJson: {},
				prompt: "x",
				trigger: "manual",
			});
			return { handle, events, runId: run.id };
		};

		function append(
			events: EventsRepo,
			runId: string,
			seq: number,
			kind = "text",
			stream: "stdout" | "stderr" | "system" = "stdout",
		) {
			return events.append({
				runId,
				sandboxEventSeq: seq,
				ts: new Date(2026, 4, 8, 12, 0, seq).toISOString(),
				kind,
				stream,
				payload: { seq },
			});
		}

		test("append returns the inserted row with an autoincrement id and parsed payload", async () => {
			const { handle, events, runId } = await open();
			try {
				const row = await append(events, runId, 1);
				expect(row.id).toBeGreaterThan(0);
				expect(row.runId).toBe(runId);
				expect(row.sandboxEventSeq).toBe(1);
				expect(row.payloadJson).toEqual({ seq: 1 });
			} finally {
				await handle.close();
			}
		});

		test("listByRun returns events ordered by sandbox_event_seq", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 3);
				await append(events, runId, 1);
				await append(events, runId, 2);
				const got = (await events.listByRun(runId)).map((e) => e.sandboxEventSeq);
				expect(got).toEqual([1, 2, 3]);
			} finally {
				await handle.close();
			}
		});

		test("listByRun({ sinceSeq }) excludes events at or below the cursor", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 1);
				await append(events, runId, 2);
				await append(events, runId, 3);
				const got = (await events.listByRun(runId, { sinceSeq: 1 })).map((e) => e.sandboxEventSeq);
				expect(got).toEqual([2, 3]);
			} finally {
				await handle.close();
			}
		});

		test("listByRun({ limit }) caps the page size", async () => {
			const { handle, events, runId } = await open();
			try {
				for (let i = 1; i <= 10; i++) await append(events, runId, i);
				expect((await events.listByRun(runId, { limit: 3 })).map((e) => e.sandboxEventSeq)).toEqual(
					[1, 2, 3],
				);
			} finally {
				await handle.close();
			}
		});

		test("listTail returns the last N in seq-ascending order", async () => {
			const { handle, events, runId } = await open();
			try {
				for (let i = 1; i <= 5; i++) await append(events, runId, i);
				expect((await events.listTail(runId, 2)).map((e) => e.sandboxEventSeq)).toEqual([4, 5]);
			} finally {
				await handle.close();
			}
		});

		test("listTail with limit <= 0 returns []", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 1);
				expect(await events.listTail(runId, 0)).toEqual([]);
				expect(await events.listTail(runId, -1)).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("maxSeqForRun returns null when no events exist, else the max seq", async () => {
			const { handle, events, runId } = await open();
			try {
				expect(await events.maxSeqForRun(runId)).toBeNull();
				await append(events, runId, 1);
				await append(events, runId, 7);
				await append(events, runId, 3);
				expect(await events.maxSeqForRun(runId)).toBe(7);
			} finally {
				await handle.close();
			}
		});

		test("countByRun reports the row count", async () => {
			const { handle, events, runId } = await open();
			try {
				expect(await events.countByRun(runId)).toBe(0);
				await append(events, runId, 1);
				await append(events, runId, 2);
				expect(await events.countByRun(runId)).toBe(2);
			} finally {
				await handle.close();
			}
		});

		test("listToolEventsForRun returns only tool_use/tool_result rows ordered by seq", async () => {
			const { handle, events, runId } = await open();
			try {
				await append(events, runId, 1, "text");
				await append(events, runId, 4, "tool_result");
				await append(events, runId, 2, "tool_use");
				await append(events, runId, 3, "thinking");
				const rows = await events.listToolEventsForRun(runId);
				expect(rows.map((r) => [r.kind, r.sandboxEventSeq])).toEqual([
					["tool_use", 2],
					["tool_result", 4],
				]);
			} finally {
				await handle.close();
			}
		});

		test("listToolEventsForRun is scoped to one run and uncapped (backfill source)", async () => {
			const { handle, events, runId } = await open();
			try {
				for (let seq = 1; seq <= 5; seq++) {
					await append(events, runId, seq, "tool_use");
				}
				const rows = await events.listToolEventsForRun(runId);
				expect(rows.map((r) => r.sandboxEventSeq)).toEqual([1, 2, 3, 4, 5]);
			} finally {
				await handle.close();
			}
		});

		test("payloadKeyHistory counts every matching row past the listByKind window", async () => {
			const { handle, events, runId } = await open();
			try {
				const append1 = (seq: number, fingerprint: string, ts: string) =>
					events.append({
						runId,
						sandboxEventSeq: seq,
						ts,
						kind: "heal.dispatched",
						payload: { fingerprint },
					});
				// Two attempts for the fingerprint under test, oldest first.
				await append1(1, "fp-target", "2026-05-01T00:00:00.000Z");
				await append1(2, "fp-target", "2026-05-01T01:00:00.000Z");
				// 600 unrelated dispatches scroll the target rows out of the 500-row
				// newest-first window listByKind returns (warren-55cf).
				for (let i = 0; i < 600; i++) {
					await append1(
						100 + i,
						`fp-noise-${i}`,
						`2026-06-01T00:00:00.${String(i).padStart(3, "0")}Z`,
					);
				}

				const windowed = await events.listByKind("heal.dispatched");
				expect(windowed.length).toBe(500);
				expect(
					windowed.some(
						(r) => (r.payloadJson as { fingerprint?: string }).fingerprint === "fp-target",
					),
				).toBe(false);

				const history = await events.payloadKeyHistory(
					"heal.dispatched",
					"fingerprint",
					"fp-target",
				);
				expect(history.count).toBe(2);
				expect(history.lastTs).toBe("2026-05-01T01:00:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("payloadKeyHistory ignores other kinds and unknown fingerprints", async () => {
			const { handle, events, runId } = await open();
			try {
				await events.append({
					runId,
					sandboxEventSeq: 1,
					ts: "2026-05-01T00:00:00.000Z",
					kind: "other.kind",
					payload: { fingerprint: "fp-a" },
				});
				expect(await events.payloadKeyHistory("heal.dispatched", "fingerprint", "fp-a")).toEqual({
					count: 0,
					lastTs: null,
				});
				expect(await events.payloadKeyHistory("other.kind", "fingerprint", "fp-a")).toEqual({
					count: 1,
					lastTs: "2026-05-01T00:00:00.000Z",
				});
			} finally {
				await handle.close();
			}
		});

		test("nullable stream column round-trips as null", async () => {
			const { handle, events, runId } = await open();
			try {
				const row = await events.append({
					runId,
					sandboxEventSeq: 1,
					ts: "2026-05-08T12:00:00.000Z",
					kind: "system",
					payload: {},
				});
				expect(row.stream).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("origin round-trips and defaults to null (warren-5a07)", async () => {
			const { handle, events, runId } = await open();
			try {
				const withOrigin = await events.append({
					runId,
					sandboxEventSeq: 1,
					ts: "2026-05-08T12:00:00.000Z",
					kind: "text",
					origin: "agent",
					payload: {},
				});
				const withoutOrigin = await events.append({
					runId,
					sandboxEventSeq: 2,
					ts: "2026-05-08T12:00:01.000Z",
					kind: "text",
					payload: {},
				});
				expect(withOrigin.origin).toBe("agent");
				expect(withoutOrigin.origin).toBeNull();
			} finally {
				await handle.close();
			}
		});
		test("listUsageEvents returns exactly the usage envelopes (warren-5dd5)", async () => {
			const { handle, events, runId } = await open();
			try {
				const types = [
					"turn_start",
					"turn_end",
					"tool_execution_start",
					"tool_execution_end",
					"message_start",
					"message_end",
					"agent_end",
					"result",
				];
				for (const [i, type] of types.entries()) {
					await events.append({
						runId,
						sandboxEventSeq: i + 1,
						ts: new Date(2026, 4, 8, 12, 0, i).toISOString(),
						kind: "state_change",
						stream: "system",
						payload: { type, usage: { input_tokens: 1 } },
					});
				}
				// Off-carrier rows sharing the usage types must stay excluded:
				// wrong kind, wrong stream, and another run's envelope.
				await events.append({
					runId,
					sandboxEventSeq: 100,
					ts: new Date(2026, 4, 8, 12, 1, 0).toISOString(),
					kind: "state_change",
					stream: "stdout",
					payload: { type: "turn_end" },
				});
				await events.append({
					runId,
					sandboxEventSeq: 101,
					ts: new Date(2026, 4, 8, 12, 1, 1).toISOString(),
					kind: "text",
					stream: "system",
					payload: { type: "turn_end" },
				});

				const rows = await events.listUsageEvents([runId]);
				expect(rows.map((r) => (r.payloadJson as { type?: string }).type)).toEqual([
					"turn_end",
					"result",
				]);
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
