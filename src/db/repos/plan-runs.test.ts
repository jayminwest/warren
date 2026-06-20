import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { assertPlanRunTransition, PlanRunsRepo } from "./plan-runs.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunsRepo } from "./runs.ts";

describe("assertPlanRunTransition", () => {
	test("queued → running, cancelled are allowed", () => {
		expect(() => assertPlanRunTransition("queued", "running")).not.toThrow();
		expect(() => assertPlanRunTransition("queued", "cancelled")).not.toThrow();
	});

	test("running → succeeded|failed|cancelled are allowed", () => {
		expect(() => assertPlanRunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertPlanRunTransition("running", "failed")).not.toThrow();
		expect(() => assertPlanRunTransition("running", "cancelled")).not.toThrow();
	});

	test("queued → succeeded is rejected (must traverse running)", () => {
		expect(() => assertPlanRunTransition("queued", "succeeded")).toThrow(StateTransitionError);
	});

	test("terminal states are sticky", () => {
		expect(() => assertPlanRunTransition("succeeded", "running")).toThrow(StateTransitionError);
		expect(() => assertPlanRunTransition("failed", "running")).toThrow(StateTransitionError);
		expect(() => assertPlanRunTransition("cancelled", "running")).toThrow(StateTransitionError);
	});
});

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`PlanRunsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const runs = new RunsRepo(adapter);
			const repo = new PlanRunsRepo(adapter);
			const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, adapter, agents, projects, runs, repo, agentName: a.name, projectId: p.id };
		};

		const seed = (overrides: { agentName: string; projectId: string }) => ({
			planId: "pl-acme01",
			projectId: overrides.projectId,
			agentName: overrides.agentName,
			children: [
				{ seq: 1, seedId: "warren-aaaa" },
				{ seq: 2, seedId: "warren-bbbb" },
				{ seq: 3, seedId: "warren-cccc" },
			],
		});

		test("create persists the parent + every child atomically", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun, children } = await repo.create(seed({ agentName, projectId }));
				expect(planRun.state).toBe("queued");
				expect(planRun.promptTemplate).toBe("work on sd {seed_id}");
				expect(planRun.dispatcherHandle).toBe("operator");
				expect(planRun.trigger).toBe("manual");
				expect(children).toHaveLength(3);
				const reread = await repo.listChildren(planRun.id);
				expect(reread.map((c) => c.seq)).toEqual([1, 2, 3]);
				expect(reread.every((c) => c.state === "pending")).toBe(true);
				expect(reread.every((c) => c.runId === null)).toBe(true);
			} finally {
				await handle.close();
			}
		});

		test("create rolls back when a duplicate seq is supplied mid-tx", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				await expect(
					repo.create({
						planId: "pl-dup01",
						projectId,
						agentName,
						children: [
							{ seq: 1, seedId: "warren-aaaa" },
							{ seq: 1, seedId: "warren-bbbb" },
						],
					}),
				).rejects.toThrow();
				// Parent must NOT have been left behind by the failed tx.
				const rows = await repo.listByProjectAndState(projectId);
				expect(rows.map((r) => r.planId)).not.toContain("pl-dup01");
			} finally {
				await handle.close();
			}
		});

		test("create rejects an empty child list", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				await expect(
					repo.create({ planId: "pl-empty", projectId, agentName, children: [] }),
				).rejects.toThrow(ValidationError);
			} finally {
				await handle.close();
			}
		});

		test("transitionTo guards illegal advances", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				await expect(repo.transitionTo(planRun.id, "succeeded")).rejects.toThrow(
					StateTransitionError,
				);
				const running = await repo.transitionTo(planRun.id, "running", {
					startedAt: "2026-05-17T00:00:00.000Z",
				});
				expect(running.state).toBe("running");
				expect(running.startedAt).toBe("2026-05-17T00:00:00.000Z");
				const succeeded = await repo.transitionTo(planRun.id, "succeeded", {
					endedAt: "2026-05-17T00:05:00.000Z",
				});
				expect(succeeded.state).toBe("succeeded");
				expect(succeeded.endedAt).toBe("2026-05-17T00:05:00.000Z");
				await expect(repo.transitionTo(planRun.id, "cancelled")).rejects.toThrow(
					StateTransitionError,
				);
			} finally {
				await handle.close();
			}
		});

		test("transitionTo records a failure reason on the failed transition", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				await repo.transitionTo(planRun.id, "running");
				const failed = await repo.transitionTo(planRun.id, "failed", {
					failureReason: "pr_closed_without_merge",
					endedAt: "2026-05-17T00:10:00.000Z",
				});
				expect(failed.state).toBe("failed");
				expect(failed.failureReason).toBe("pr_closed_without_merge");
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for unknown id", async () => {
			const { handle, repo } = await open();
			try {
				await expect(repo.require("plnr_doesnotexist")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("pickNextPending returns lowest-seq pending child", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				const first = await repo.pickNextPending(planRun.id);
				expect(first?.seq).toBe(1);
				await repo.updateChild({
					planRunId: planRun.id,
					seq: 1,
					patch: { state: "skipped" },
				});
				const next = await repo.pickNextPending(planRun.id);
				expect(next?.seq).toBe(2);
			} finally {
				await handle.close();
			}
		});

		test("pickNextPending returns null when no child is pending", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				for (const seq of [1, 2, 3]) {
					await repo.updateChild({
						planRunId: planRun.id,
						seq,
						patch: { state: "merged" },
					});
				}
				expect(await repo.pickNextPending(planRun.id)).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("updateChild merges partial patches and bumps updatedAt", async () => {
			const { handle, repo, runs, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				const run = await runs.create({
					agentName,
					projectId,
					prompt: "work on sd warren-aaaa",
					renderedAgentJson: { sections: {} },
					trigger: "plan-run",
				});
				const patched = await repo.updateChild({
					planRunId: planRun.id,
					seq: 1,
					patch: { runId: run.id, state: "dispatched", startedAt: "2026-05-17T00:01:00.000Z" },
					now: new Date("2026-05-17T00:01:00.000Z"),
				});
				expect(patched.runId).toBe(run.id);
				expect(patched.state).toBe("dispatched");
				expect(patched.startedAt).toBe("2026-05-17T00:01:00.000Z");
				expect(patched.updatedAt).toBe("2026-05-17T00:01:00.000Z");

				const merged = await repo.updateChild({
					planRunId: planRun.id,
					seq: 1,
					patch: { state: "merged", prMergedAt: "2026-05-17T00:09:00.000Z" },
					now: new Date("2026-05-17T00:09:00.000Z"),
				});
				expect(merged.state).toBe("merged");
				expect(merged.prMergedAt).toBe("2026-05-17T00:09:00.000Z");
				// runId + startedAt preserved.
				expect(merged.runId).toBe(run.id);
				expect(merged.startedAt).toBe("2026-05-17T00:01:00.000Z");
			} finally {
				await handle.close();
			}
		});

		test("updateChild throws ValidationError when patch is empty", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				await expect(
					repo.updateChild({ planRunId: planRun.id, seq: 1, patch: {} }),
				).rejects.toThrow(ValidationError);
			} finally {
				await handle.close();
			}
		});

		test("updateChild throws NotFoundError for an unknown (planRunId, seq)", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				await expect(
					repo.updateChild({ planRunId: planRun.id, seq: 99, patch: { state: "merged" } }),
				).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("listActive omits terminal rows", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const queued = await repo.create(seed({ agentName, projectId }));
				const willSucceed = await repo.create({
					...seed({ agentName, projectId }),
					planId: "pl-b",
				});
				const willFail = await repo.create({ ...seed({ agentName, projectId }), planId: "pl-c" });
				const willCancel = await repo.create({ ...seed({ agentName, projectId }), planId: "pl-d" });
				await repo.transitionTo(willSucceed.planRun.id, "running");
				await repo.transitionTo(willSucceed.planRun.id, "succeeded");
				await repo.transitionTo(willFail.planRun.id, "running");
				await repo.transitionTo(willFail.planRun.id, "failed");
				await repo.transitionTo(willCancel.planRun.id, "cancelled");
				const active = await repo.listActive();
				const activeIds = active.map((r) => r.id);
				expect(activeIds).toContain(queued.planRun.id);
				expect(activeIds).not.toContain(willSucceed.planRun.id);
				expect(activeIds).not.toContain(willFail.planRun.id);
				expect(activeIds).not.toContain(willCancel.planRun.id);
			} finally {
				await handle.close();
			}
		});

		test("listByProjectAndState filters by single state and array", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const a = await repo.create(seed({ agentName, projectId }));
				const b = await repo.create({ ...seed({ agentName, projectId }), planId: "pl-b" });
				await repo.transitionTo(b.planRun.id, "running");
				const queued = await repo.listByProjectAndState(projectId, "queued");
				expect(queued.map((r) => r.id)).toEqual([a.planRun.id]);
				const both = await repo.listByProjectAndState(projectId, ["queued", "running"]);
				expect(both.map((r) => r.id).sort()).toEqual([a.planRun.id, b.planRun.id].sort());
				const everything = await repo.listByProjectAndState(projectId);
				expect(everything).toHaveLength(2);
				expect(await repo.listByProjectAndState("prj_nope")).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("listDispatchedPlanIds returns empty for a project with no plan-runs", async () => {
			const { handle, repo, projectId } = await open();
			try {
				expect(await repo.listDispatchedPlanIds(projectId)).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("listDispatchedPlanIds collapses multiple plan-runs for one plan id", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				await repo.create({ ...seed({ agentName, projectId }), planId: "pl-dup" });
				await repo.create({ ...seed({ agentName, projectId }), planId: "pl-dup" });
				await repo.create({ ...seed({ agentName, projectId }), planId: "pl-other" });
				const ids = await repo.listDispatchedPlanIds(projectId);
				expect(ids.sort()).toEqual(["pl-dup", "pl-other"]);
			} finally {
				await handle.close();
			}
		});

		test("listDispatchedPlanIds scopes to the requested project", async () => {
			const { handle, repo, projects, agentName, projectId } = await open();
			try {
				const other = await projects.create({
					gitUrl: "https://github.com/x/z.git",
					localPath: "/data/projects/x/z",
					defaultBranch: "main",
				});
				await repo.create({ ...seed({ agentName, projectId }), planId: "pl-here" });
				await repo.create({
					...seed({ agentName, projectId: other.id }),
					planId: "pl-there",
				});
				expect(await repo.listDispatchedPlanIds(projectId)).toEqual(["pl-here"]);
				expect(await repo.listDispatchedPlanIds(other.id)).toEqual(["pl-there"]);
				expect(await repo.listDispatchedPlanIds("prj_nope")).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("deleting the parent cascades to children", async () => {
			const { handle, adapter, repo, agentName, projectId } = await open();
			try {
				const { planRun } = await repo.create(seed({ agentName, projectId }));
				const planRuns = adapter.schema.planRuns;
				const db = adapter.drizzle as SqliteDrizzleDb;
				await adapter.runWrite(db.delete(planRuns).where(eq(planRuns.id, planRun.id)));
				expect(await repo.listChildren(planRun.id)).toEqual([]);
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
