import { describe, expect, test } from "bun:test";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunInboxRepo } from "./run-inbox.ts";
import { RunsRepo } from "./runs.ts";

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunInboxRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const repo = new RunInboxRepo(adapter);
			const project = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const mkRun = async () => {
				const run = await runs.create({
					agentName: "claude-code",
					projectId: project.id,
					prompt: "do the thing",
					renderedAgentJson: {},
					trigger: "manual",
				});
				return run.id;
			};
			return { handle, repo, mkRun };
		};

		test("enqueue auto-allocates monotonic seq per run and returns unread rows", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				const m1 = await repo.enqueue({ runId, body: "first" });
				const m2 = await repo.enqueue({ runId, body: "second" });
				expect(m1).not.toBeNull();
				expect(m2).not.toBeNull();
				expect(m1?.seq).toBe(1);
				expect(m2?.seq).toBe(2);
				expect(m1?.state).toBe("unread");
				expect(m1?.priority).toBe("normal");
				expect(m1?.fromActor).toBe("operator");
				expect(m1?.deliveredAt).toBeNull();
				expect(m1?.id.startsWith("msg_")).toBe(true);
			} finally {
				await handle.close();
			}
		});

		test("enqueue is per-run scoped: seq resets across runs", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runA = await mkRun();
				const runB = await mkRun();
				const a1 = await repo.enqueue({ runId: runA, body: "a1" });
				const b1 = await repo.enqueue({ runId: runB, body: "b1" });
				expect(a1?.seq).toBe(1);
				expect(b1?.seq).toBe(1);
			} finally {
				await handle.close();
			}
		});

		test("enqueue returns null for an unknown run (maps to RuntimeRunNotFoundError)", async () => {
			const { handle, repo } = await open();
			try {
				const row = await repo.enqueue({ runId: "run_doesnotexist", body: "ghost" });
				expect(row).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("enqueue honors explicit priority + fromActor", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				const m = await repo.enqueue({
					runId,
					body: "urgent one",
					priority: "urgent",
					fromActor: "watchdog",
				});
				expect(m?.priority).toBe("urgent");
				expect(m?.fromActor).toBe("watchdog");
			} finally {
				await handle.close();
			}
		});

		test("claimForDelivery orders priority-desc then FIFO within a class", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				// Insertion order deliberately scrambles priority so the claim ordering
				// is proven, not accidental.
				await repo.enqueue({ runId, body: "n1", priority: "normal" });
				await repo.enqueue({ runId, body: "u1", priority: "urgent" });
				await repo.enqueue({ runId, body: "l1", priority: "low" });
				await repo.enqueue({ runId, body: "h1", priority: "high" });
				await repo.enqueue({ runId, body: "u2", priority: "urgent" });
				await repo.enqueue({ runId, body: "n2", priority: "normal" });

				const claimed = await repo.claimForDelivery(runId);
				expect(claimed.map((r) => r.body)).toEqual(["u1", "u2", "h1", "n1", "n2", "l1"]);
				// Every claimed row is now delivered with a timestamp.
				for (const r of claimed) {
					expect(r.state).toBe("delivered");
					expect(r.deliveredAt).not.toBeNull();
				}
			} finally {
				await handle.close();
			}
		});

		test("claimForDelivery keeps a total order when a row holds an unknown priority", async () => {
			// warren-b27c: handlers refuse an out-of-vocabulary priority, but the
			// column has no SQL CHECK, so a legacy row can still hold one. The rank
			// lookup must not yield NaN (a non-total comparator hands Array.sort
			// implementation-defined ordering).
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				await repo.enqueue({ runId, body: "n1", priority: "normal" });
				await repo.enqueue({
					runId,
					body: "bogus",
					priority: "CRITICAL" as "urgent",
				});
				await repo.enqueue({ runId, body: "u1", priority: "urgent" });

				const claimed = await repo.claimForDelivery(runId);
				// Unknown ranks below every known class, deterministically last.
				expect(claimed.map((r) => r.body)).toEqual(["u1", "n1", "bogus"]);
			} finally {
				await handle.close();
			}
		});

		test("claimForDelivery drains only unread rows; a second poll is empty", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				await repo.enqueue({ runId, body: "one" });
				await repo.enqueue({ runId, body: "two" });

				const first = await repo.claimForDelivery(runId);
				expect(first.map((r) => r.body)).toEqual(["one", "two"]);

				const second = await repo.claimForDelivery(runId);
				expect(second).toEqual([]);

				// A newly enqueued row is picked up by the next poll only.
				await repo.enqueue({ runId, body: "three" });
				const third = await repo.claimForDelivery(runId);
				expect(third.map((r) => r.body)).toEqual(["three"]);
			} finally {
				await handle.close();
			}
		});

		test("concurrent claims never double-deliver a row", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runId = await mkRun();
				for (let i = 0; i < 8; i++) {
					await repo.enqueue({ runId, body: `m${i}` });
				}
				const [a, b] = await Promise.all([
					repo.claimForDelivery(runId),
					repo.claimForDelivery(runId),
				]);
				const bodies = [...a, ...b].map((r) => r.body).sort();
				// Union covers every message exactly once, intersection is empty.
				expect(bodies).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
				const idsA = new Set(a.map((r) => r.id));
				expect(b.some((r) => idsA.has(r.id))).toBe(false);
			} finally {
				await handle.close();
			}
		});

		test("claimForDelivery scopes to the target run", async () => {
			const { handle, repo, mkRun } = await open();
			try {
				const runA = await mkRun();
				const runB = await mkRun();
				await repo.enqueue({ runId: runA, body: "for-a" });
				await repo.enqueue({ runId: runB, body: "for-b" });
				const claimedA = await repo.claimForDelivery(runA);
				expect(claimedA.map((r) => r.body)).toEqual(["for-a"]);
				// runB's row is untouched.
				const stillUnread = await repo.listByRun(runB);
				expect(stillUnread.map((r) => r.state)).toEqual(["unread"]);
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) suite("postgres");
