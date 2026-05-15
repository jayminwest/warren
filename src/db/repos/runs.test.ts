import { describe, expect, test } from "bun:test";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { assertRunTransition, RunsRepo } from "./runs.ts";

describe("assertRunTransition", () => {
	test("queued → running is allowed", () => {
		expect(() => assertRunTransition("queued", "running")).not.toThrow();
	});

	test("running → succeeded|failed|cancelled is allowed", () => {
		expect(() => assertRunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertRunTransition("running", "failed")).not.toThrow();
		expect(() => assertRunTransition("running", "cancelled")).not.toThrow();
	});

	test("queued → cancelled is allowed (steer-before-pickup)", () => {
		expect(() => assertRunTransition("queued", "cancelled")).not.toThrow();
	});

	test("succeeded is terminal", () => {
		expect(() => assertRunTransition("succeeded", "running")).toThrow(StateTransitionError);
		expect(() => assertRunTransition("succeeded", "failed")).toThrow(StateTransitionError);
	});

	test("queued → succeeded is rejected", () => {
		expect(() => assertRunTransition("queued", "succeeded")).toThrow(StateTransitionError);
	});
});

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunsRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			const agents = new AgentsRepo(adapter);
			const projects = new ProjectsRepo(adapter);
			const repo = new RunsRepo(adapter);
			const a = await agents.upsert({ name: "refactor-bot", renderedJson: { sections: {} } });
			const p = await projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			return { handle, repo, agentName: a.name, projectId: p.id };
		};

		function spawn(
			repo: RunsRepo,
			agentName: string,
			projectId: string,
			extra: Partial<Parameters<RunsRepo["create"]>[0]> = {},
		) {
			return repo.create({
				agentName,
				projectId,
				prompt: "fix the flaky test",
				renderedAgentJson: { sections: {} },
				trigger: "manual",
				...extra,
			});
		}

		test("create stores a queued run with a run_ id and no timestamps", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(isId("run", row.id)).toBe(true);
				expect(row.state).toBe("queued");
				expect(row.startedAt).toBeNull();
				expect(row.endedAt).toBeNull();
				expect(row.burrowId).toBeNull();
				expect(row.burrowRunId).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("require throws NotFoundError for unknown id", async () => {
			const { handle, repo } = await open();
			try {
				expect(repo.require("run_doesnotexist")).rejects.toThrow(NotFoundError);
			} finally {
				await handle.close();
			}
		});

		test("attachBurrow tags the row with burrow ids without changing state", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const tagged = await repo.attachBurrow(row.id, {
					burrowId: "bur_xxxxxxxxxxxx",
					burrowRunId: "run_yyyyyyyyyyyy",
				});
				expect(tagged.burrowId).toBe("bur_xxxxxxxxxxxx");
				expect(tagged.burrowRunId).toBe("run_yyyyyyyyyyyy");
				expect(tagged.state).toBe("queued");
				const reread = await repo.require(row.id);
				expect(reread.burrowId).toBe("bur_xxxxxxxxxxxx");
			} finally {
				await handle.close();
			}
		});

		test("create leaves cost + token columns null", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(row.costUsd).toBeNull();
				expect(row.tokensInput).toBeNull();
				expect(row.tokensOutput).toBeNull();
				expect(row.tokensCacheRead).toBeNull();
				expect(row.tokensCacheWrite).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("attachStats persists partial cost + token fields", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const tagged = await repo.attachStats(row.id, {
					costUsd: 0.4567,
					tokensInput: 1200,
					tokensOutput: 340,
				});
				expect(tagged.costUsd).toBeCloseTo(0.4567);
				expect(tagged.tokensInput).toBe(1200);
				expect(tagged.tokensOutput).toBe(340);
				expect(tagged.tokensCacheRead).toBeNull();
				expect(tagged.tokensCacheWrite).toBeNull();
				const reread = await repo.require(row.id);
				expect(reread.costUsd).toBeCloseTo(0.4567);
				expect(reread.tokensInput).toBe(1200);
			} finally {
				await handle.close();
			}
		});

		test("attachStats merges across calls — omitted fields preserved", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.attachStats(row.id, { costUsd: 0.1, tokensInput: 100 });
				const merged = await repo.attachStats(row.id, { costUsd: 0.25, tokensOutput: 50 });
				expect(merged.costUsd).toBeCloseTo(0.25);
				expect(merged.tokensInput).toBe(100);
				expect(merged.tokensOutput).toBe(50);
			} finally {
				await handle.close();
			}
		});

		test("attachStats accepts explicit null to clear a field", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.attachStats(row.id, { costUsd: 0.5 });
				const cleared = await repo.attachStats(row.id, { costUsd: null });
				expect(cleared.costUsd).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("attachStats throws when called with no fields", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(repo.attachStats(row.id, {})).rejects.toThrow(ValidationError);
			} finally {
				await handle.close();
			}
		});

		test("create leaves preview columns null", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(row.previewState).toBeNull();
				expect(row.previewPort).toBeNull();
				expect(row.previewStartedAt).toBeNull();
				expect(row.previewLastHitAt).toBeNull();
				expect(row.previewFailureMessage).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("attachPreview persists partial preview fields", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const startedAt = "2026-05-14T18:00:00.000Z";
				const tagged = await repo.attachPreview(row.id, {
					previewState: "starting",
					previewPort: 48201,
					previewStartedAt: startedAt,
				});
				expect(tagged.previewState).toBe("starting");
				expect(tagged.previewPort).toBe(48201);
				expect(tagged.previewStartedAt).toBe(startedAt);
				expect(tagged.previewLastHitAt).toBeNull();
				expect(tagged.previewFailureMessage).toBeNull();
				const reread = await repo.require(row.id);
				expect(reread.previewState).toBe("starting");
				expect(reread.previewPort).toBe(48201);
			} finally {
				await handle.close();
			}
		});

		test("attachPreview merges across calls — omitted fields preserved", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const startedAt = "2026-05-14T18:00:00.000Z";
				await repo.attachPreview(row.id, {
					previewState: "starting",
					previewPort: 48201,
					previewStartedAt: startedAt,
				});
				const live = await repo.attachPreview(row.id, { previewState: "live" });
				expect(live.previewState).toBe("live");
				expect(live.previewPort).toBe(48201);
				expect(live.previewStartedAt).toBe(startedAt);
			} finally {
				await handle.close();
			}
		});

		test("attachPreview accepts explicit null to clear a field", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.attachPreview(row.id, {
					previewState: "failed",
					previewFailureMessage: "boot crashed",
				});
				const cleared = await repo.attachPreview(row.id, { previewFailureMessage: null });
				expect(cleared.previewState).toBe("failed");
				expect(cleared.previewFailureMessage).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("attachPreview throws when called with no fields", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(repo.attachPreview(row.id, {})).rejects.toThrow(ValidationError);
			} finally {
				await handle.close();
			}
		});

		test("attachPreview last_hit_at independent updates (proxy path)", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.attachPreview(row.id, { previewState: "live", previewPort: 48201 });
				const hit = "2026-05-14T18:05:00.000Z";
				const touched = await repo.attachPreview(row.id, { previewLastHitAt: hit });
				expect(touched.previewLastHitAt).toBe(hit);
				expect(touched.previewState).toBe("live");
				expect(touched.previewPort).toBe(48201);
			} finally {
				await handle.close();
			}
		});

		test("markRunning sets state and startedAt", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const t = new Date("2026-05-08T12:34:56.000Z");
				const running = await repo.markRunning(row.id, t);
				expect(running.state).toBe("running");
				expect(running.startedAt).toBe(t.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("markRunning rejects already-running rows", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.markRunning(row.id);
				expect(repo.markRunning(row.id)).rejects.toThrow(StateTransitionError);
			} finally {
				await handle.close();
			}
		});

		test("finalize sets terminal state and endedAt", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.markRunning(row.id);
				const t = new Date("2026-05-08T13:00:00.000Z");
				const done = await repo.finalize(row.id, "succeeded", t);
				expect(done.state).toBe("succeeded");
				expect(done.endedAt).toBe(t.toISOString());
			} finally {
				await handle.close();
			}
		});

		test("finalize rejects an invalid transition (queued → succeeded)", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				expect(repo.finalize(row.id, "succeeded")).rejects.toThrow(StateTransitionError);
			} finally {
				await handle.close();
			}
		});

		test("claimById transitions queued → running atomically", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				const claimed = await repo.claimById(row.id);
				expect(claimed?.state).toBe("running");
				expect(claimed?.startedAt).not.toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("claimById returns null when the row is not queued", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const row = await spawn(repo, agentName, projectId);
				await repo.markRunning(row.id);
				expect(await repo.claimById(row.id)).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("claimById returns null for an unknown id", async () => {
			const { handle, repo } = await open();
			try {
				expect(await repo.claimById("run_doesnotexist")).toBeNull();
			} finally {
				await handle.close();
			}
		});

		test("listByProject and listByAgent filter the result set", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const a = await spawn(repo, agentName, projectId);
				const b = await spawn(repo, agentName, projectId);
				expect((await repo.listByProject(projectId)).map((r) => r.id).sort()).toEqual(
					[a.id, b.id].sort(),
				);
				expect((await repo.listByAgent(agentName)).map((r) => r.id).sort()).toEqual(
					[a.id, b.id].sort(),
				);
				expect(await repo.listByProject("prj_nope")).toEqual([]);
			} finally {
				await handle.close();
			}
		});

		test("listAll sorts by cost with NULLS LAST in both directions", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const cheap = await spawn(repo, agentName, projectId);
				const pricey = await spawn(repo, agentName, projectId);
				const unbilled = await spawn(repo, agentName, projectId);
				await repo.attachStats(cheap.id, { costUsd: 0.05 });
				await repo.attachStats(pricey.id, { costUsd: 1.23 });
				// `unbilled` has costUsd === null.

				const desc = await repo.listAll({ sort: "cost", dir: "desc" });
				expect(desc.map((r) => r.id)).toEqual([pricey.id, cheap.id, unbilled.id]);

				const asc = await repo.listAll({ sort: "cost", dir: "asc" });
				expect(asc.map((r) => r.id)).toEqual([cheap.id, pricey.id, unbilled.id]);
			} finally {
				await handle.close();
			}
		});

		test("listByState filters by single state and arrays", async () => {
			const { handle, repo, agentName, projectId } = await open();
			try {
				const a = await spawn(repo, agentName, projectId);
				const b = await spawn(repo, agentName, projectId);
				await repo.markRunning(a.id);
				expect((await repo.listByState("queued")).map((r) => r.id)).toEqual([b.id]);
				expect((await repo.listByState(["queued", "running"])).map((r) => r.id).sort()).toEqual(
					[a.id, b.id].sort(),
				);
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
