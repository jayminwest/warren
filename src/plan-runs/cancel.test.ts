import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { type CancelPlanRunLogger, cancelPlanRun } from "./cancel.ts";

const RUNTIME_PROVIDER = { kind: "stub" } as unknown as RuntimeProvider;

describe("cancelPlanRun", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/x/seedy.git",
				localPath: "/tmp/seedy",
				defaultBranch: "main",
				hasSeeds: true,
			})
		).id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function makeRunningPlanRun(): Promise<{ planRunId: string; childRunId: string }> {
		const created = await repos.planRuns.create({
			planId: "pl-cancel",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});
		// Queued run with NO sandbox_run_id — cancelRun's "partial spawn"
		// branch cancels it without a runtime round-trip.
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: childRun.id, state: "dispatched", startedAt: new Date().toISOString() },
		});
		return { planRunId: created.planRun.id, childRunId: childRun.id };
	}

	test("cancels the in-flight child via cancelRun and flips the plan-run to cancelled", async () => {
		const { planRunId, childRunId } = await makeRunningPlanRun();
		const result = await cancelPlanRun({
			planRunId,
			repos,
			runtimeProvider: RUNTIME_PROVIDER,
		});
		expect(result.planRun.state).toBe("cancelled");
		expect(result.planRun.endedAt).not.toBeNull();
		expect(result.cancelledChild).toEqual({ childSeq: 1, runId: childRunId });
		expect(result.alreadyTerminal).toBe(false);

		const persistedChild = await repos.runs.require(childRunId);
		expect(persistedChild.state).toBe("cancelled");
	});

	test("is idempotent against an already-terminal plan-run", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-terminal",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "cancelled", {
			endedAt: new Date().toISOString(),
		});

		const result = await cancelPlanRun({
			planRunId: created.planRun.id,
			repos,
			runtimeProvider: RUNTIME_PROVIDER,
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(result.cancelledChild).toBeNull();
		expect(result.planRun.state).toBe("cancelled");
	});

	test("survives a failed child cancel: plan-run still cancels, warning logged", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-cancel",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});
		// A child run with a burrow handle whose provider.cancel throws —
		// cancelRun rejects, and the domain swallows it into a warning.
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
			sandboxId: "burrow_x",
			sandboxRunId: "br_x",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: childRun.id, state: "dispatched", startedAt: new Date().toISOString() },
		});
		const failingProvider = {
			cancel: async () => {
				throw new Error("backend unreachable");
			},
		} as unknown as RuntimeProvider;

		const warnings: { obj: object; msg: string | undefined }[] = [];
		const logger: CancelPlanRunLogger = {
			warn(obj, msg) {
				warnings.push({ obj, msg });
			},
		};

		const result = await cancelPlanRun({
			planRunId: created.planRun.id,
			repos,
			runtimeProvider: failingProvider,
			logger,
		});
		expect(result.planRun.state).toBe("cancelled");
		expect(result.cancelledChild).toBeNull();
		expect(result.alreadyTerminal).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.msg).toBe("plan_run.cancel_child_failed");
	});
});
