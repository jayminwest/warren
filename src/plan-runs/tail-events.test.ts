import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { EventRow } from "../db/schema.ts";
import { RunEventBroker } from "../runs/index.ts";
import { tailPlanRunEvents } from "./tail-events.ts";

describe("tailPlanRunEvents", () => {
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

	async function makePlanRunWithRun(): Promise<{ planRunId: string; runId: string }> {
		const created = await repos.planRuns.create({
			planId: "pl-tail",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: run.id, state: "dispatched", startedAt: new Date().toISOString() },
		});
		return { planRunId: created.planRun.id, runId: run.id };
	}

	function eventRow(runId: string, seq: number, kind = "stdout"): EventRow {
		return {
			id: seq,
			runId,
			sandboxEventSeq: seq,
			ts: new Date(seq * 1000).toISOString(),
			kind,
			stream: null,
			origin: null,
			payloadJson: { seq },
		};
	}

	test("replays persisted history across child runs, then closes without follow", async () => {
		const { planRunId, runId } = await makePlanRunWithRun();
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "stdout",
			payload: { line: "one" },
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "stdout",
			payload: { line: "two" },
		});

		const broker = new RunEventBroker();
		const rows: EventRow[] = [];
		for await (const row of tailPlanRunEvents({
			planRunId,
			repos,
			broker,
			follow: false,
			signal: new AbortController().signal,
		})) {
			rows.push(row);
		}
		expect(rows.map((r) => r.sandboxEventSeq)).toEqual([1, 2]);
	});

	test("follow mode yields live broker arrivals and dedupes replayed seqs", async () => {
		const { planRunId, runId } = await makePlanRunWithRun();
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "stdout",
			payload: { line: "history" },
		});

		const broker = new RunEventBroker();
		const ctrl = new AbortController();
		const rows: EventRow[] = [];
		const pump = (async () => {
			for await (const row of tailPlanRunEvents({
				planRunId,
				repos,
				broker,
				follow: true,
				signal: ctrl.signal,
			})) {
				rows.push(row);
				if (rows.length === 2) ctrl.abort();
			}
		})();

		// Wait for the subscription to attach, then publish: seq 1 replays
		// (deduped against the history high-water mark), seq 2 is new.
		for (let i = 0; i < 50 && broker.subscriberCount(runId) === 0; i++) {
			await Bun.sleep(10);
		}
		broker.publish(runId, eventRow(runId, 1));
		broker.publish(runId, eventRow(runId, 2));

		await pump;
		expect(rows.map((r) => r.sandboxEventSeq)).toEqual([1, 2]);
	});
});
