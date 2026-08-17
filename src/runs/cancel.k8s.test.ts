/**
 * K8s-topology cancel regression tests (warren-fe9b / warren-d15c). Split from
 * `cancel.test.ts` to keep both files under the per-file size budget. Covers
 * the shape only the K8s provider produces: the operator's cancel deletes the
 * pod, and by the time the domain re-reads `status()` the pod is already gone
 * from the API (`exists:false` + `terminalReason:"lost"`). The cancel intent
 * must win over the lost mapping — the row reaps to `cancelled`, never
 * `failed/sandbox_run_lost`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { cancelRun } from "./cancel.ts";
import type { ReapRunResult } from "./reap/index.ts";
import { makeReapRunResult } from "./reap/test-helpers.ts";

function reapStub(outcome: RunTerminalState): ReapRunResult {
	return makeReapRunResult({ state: outcome });
}

describe("cancelRun — K8s pod-delete topology (warren-fe9b)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function createRunningRun(): Promise<string> {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_zzzzzzzzzzzz",
		});
		await repos.runs.markRunning(run.id);
		return run.id;
	}

	test("post-cancel exists:false (the pod delete already landed) reaps cancelled, not failed/sandbox_run_lost", async () => {
		const runId = await createRunningRun();
		const provider = {
			cancel: async () => {},
			status: async () => ({
				phase: "failed" as const,
				terminalReason: "lost" as const,
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: false,
			}),
		} as unknown as RuntimeProvider;
		const reapCalls: { runId: string; outcome: string; failureReason?: string }[] = [];
		const result = await cancelRun({
			runId,
			repos,
			runtimeProvider: provider,
			reap: async (input) => {
				reapCalls.push({
					runId: input.runId,
					outcome: input.outcome,
					...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
				});
				return reapStub(input.outcome);
			},
		});
		// Reap is the costUsd-finalization path: routing the terminal transition
		// through it with outcome `cancelled` is what finalizes spend for the run.
		expect(reapCalls).toEqual([{ runId, outcome: "cancelled" }]);
		expect(result.state).toBe("cancelled");
		expect(result.sandboxRun?.state).toBe("cancelled");
		// The cancel intent is recorded on the run's event log — the watchdog
		// terminal-reconcile net reads it to resolve a later exists:false
		// observation to `cancelled` as well.
		const events = await repos.events.listByRun(runId);
		expect(events.some((e) => e.kind === "cancel.requested")).toBe(true);
	});
});
