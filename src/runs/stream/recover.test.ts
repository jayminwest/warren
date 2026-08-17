import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type {
	NormalizedEvent,
	RunHandle,
	RuntimeProvider,
	StreamOpts,
} from "../../runtime/contract.ts";
import { RunEventBroker } from "../events.ts";
import { recoverActiveRunStreams } from "./recover.ts";
import { makeProvider } from "./test-helpers.ts";
import type { BridgeRunStreamInput } from "./types.ts";

describe("recoverActiveRunStreams", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		// Seed three runs:
		//   run_a: queued + sandboxRunId  → bridge
		//   run_b: running + sandboxRunId → bridge
		//   run_c: running, no sandboxRunId → skip
		//   run_d: succeeded             → ignore
		await repos.runs.create({
			id: "run_aaaaaaaaaaaa",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_a",
			sandboxRunId: "rb_a",
		});
		const b = await repos.runs.create({
			id: "run_bbbbbbbbbbbb",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_b",
			sandboxRunId: "rb_b",
		});
		await repos.runs.markRunning(b.id);
		await repos.runs.create({
			id: "run_cccccccccccc",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await repos.runs.markRunning("run_cccccccccccc");
		const d = await repos.runs.create({
			id: "run_dddddddddddd",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_d",
			sandboxRunId: "rb_d",
		});
		await repos.runs.markRunning(d.id);
		await repos.runs.finalize(d.id, "succeeded");
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("starts a bridge for each active run with a sandbox_run_id", async () => {
		const calls: { runId: string; sandboxRunId: string }[] = [];
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			runtimeProvider: makeProvider(),
			bridge: async (input: BridgeRunStreamInput) => {
				calls.push({ runId: input.runId, sandboxRunId: input.sandboxRunId });
				return { written: 0, skipped: 0, errored: false };
			},
		});
		expect(result.bridges).toHaveLength(2);
		expect(result.skipped).toEqual([{ runId: "run_cccccccccccc", reason: "no_sandbox_run_id" }]);
		await Promise.all(result.bridges.map((b) => b.done));
		const ids = calls.map((c) => c.runId).sort();
		expect(ids).toEqual(["run_aaaaaaaaaaaa", "run_bbbbbbbbbbbb"]);
	});

	test("returned AbortControllers can stop in-flight bridges", async () => {
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			runtimeProvider: makeProvider(),
			bridge: async (input: BridgeRunStreamInput) => {
				await new Promise<void>((resolve) => {
					if (input.signal === undefined) {
						resolve();
						return;
					}
					if (input.signal.aborted) {
						resolve();
						return;
					}
					input.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { written: 0, skipped: 0, errored: false };
			},
		});
		for (const b of result.bridges) b.abort.abort();
		await Promise.all(result.bridges.map((b) => b.done));
		expect(result.bridges).toHaveLength(2);
	});
});

/**
 * Recovery after a simulated disconnect (warren-1fce). A prior bridge pass
 * persisted the first two events before the stream dropped; on restart,
 * `recoverActiveRunStreams` re-attaches through the REAL bridge, which resumes
 * `provider.streamEvents(handle, { sinceSeq })` from the events table's last
 * seq. Proves the resume cursor is forwarded and no already-persisted event is
 * duplicated.
 */
describe("recoverActiveRunStreams — resume after disconnect (warren-1fce)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;

	/** Fake provider whose `streamEvents` honors the resume cursor like LocalProvider. */
	function makeResumeProvider(
		events: NormalizedEvent[],
		seen: { sinceSeq?: number },
	): RuntimeProvider {
		return {
			...makeProvider(),
			streamEvents: (_handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> => {
				seen.sinceSeq = opts?.sinceSeq;
				const since = opts?.sinceSeq ?? 0;
				return (async function* () {
					for (const e of events) {
						if (e.seq <= since) continue;
						yield e;
					}
				})();
			},
			status: async () => ({
				phase: "running" as const,
				exitCode: null,
				lastEventSeq: 2,
				lastEventTs: null,
				exists: true,
			}),
		};
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_r",
			sandboxRunId: "rb_r",
		});
		runId = run.id;
		await repos.runs.markRunning(runId);
		// Simulate the prior (disconnected) bridge pass: seq 1 + 2 already persisted.
		for (const seq of [1, 2]) {
			await repos.events.append({
				runId,
				sandboxEventSeq: seq,
				ts: `2026-06-05T00:00:0${seq}.000Z`,
				kind: "text",
				stream: "stdout",
				payload: { seq },
			});
		}
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("re-attaches through provider.streamEvents with the resume cursor", async () => {
		const seen: { sinceSeq?: number } = {};
		const streamed: NormalizedEvent[] = [1, 2, 3, 4].map((seq) => ({
			seq,
			ts: `2026-06-05T00:00:0${seq}.000Z`,
			kind: "text",
			stream: "stdout",
			payload: { seq },
		}));
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			runtimeProvider: makeResumeProvider(streamed, seen),
		});

		expect(result.bridges).toHaveLength(1);
		const bridgeResult = await result.bridges[0]?.done;
		// The bridge resumed from the events table's last seq (2)…
		expect(seen.sinceSeq).toBe(2);
		// …so only the post-disconnect events (3, 4) were written, none re-persisted.
		expect(bridgeResult?.written).toBe(2);
		expect(bridgeResult?.skipped).toBe(0);
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(seqs).toEqual([1, 2, 3, 4]);
	});
});
