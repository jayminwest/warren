import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	answerEvent,
	makeAgentJson,
	multiPlotReader,
	PLOT_ID,
	PROJECT_ID,
	poseEvent,
	stubReader,
} from "./pause.test-helpers.ts";
import {
	PAUSE_DETECTED_KIND,
	PAUSE_RESUMED_KIND,
	PAUSE_TIMED_OUT_KIND,
	type PlotEventReader,
	type RespawnFn,
	type RespawnInput,
	tickPauseDetector,
} from "./pause.ts";

describe("tickPauseDetector", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "claude-code", renderedJson: makeAgentJson() });
		await repos.projects.create({
			id: PROJECT_ID,
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		db.raw.exec(`UPDATE projects SET has_plot = 1 WHERE id = '${PROJECT_ID}'`);
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedRunningBatch(plotId: string | null = PLOT_ID): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
			plotId,
		});
		await repos.runs.markRunning(row.id);
		return row.id;
	}

	async function seedRunningConversation(): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "<seed>",
			renderedAgentJson: makeAgentJson(),
			trigger: "conversation",
			mode: "conversation",
			plotId: PLOT_ID,
		});
		await repos.runs.markRunning(row.id);
		return row.id;
	}

	test("pauses a running batch run with an unanswered question_posed", async () => {
		const runId = await seedRunningBatch();
		const respawns: RespawnInput[] = [];
		const respawn: RespawnFn = async (input) => {
			respawns.push(input);
		};

		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});

		expect(result.paused).toEqual([{ runId, questionEventId: "2026-05-23T00:00:01Z" }]);
		expect(result.resumed).toEqual([]);
		expect(result.errors).toEqual([]);

		const row = await repos.runs.require(runId);
		expect(row.state).toBe("paused");
		expect(row.pausedAt).toBe("2026-05-23T00:00:10.000Z");
		expect(row.pausedQuestionEventId).toBe("2026-05-23T00:00:01Z");

		const events = await repos.events.listByRun(runId);
		const detected = events.find((e) => e.kind === PAUSE_DETECTED_KIND);
		expect(detected).toBeDefined();
		expect((detected?.payloadJson as { questionEventId?: string }).questionEventId).toBe(
			"2026-05-23T00:00:01Z",
		);
		// The envelope `ts` is stamped from the injected `now` clock (warren-96fd),
		// matching the payload's `pausedAt` written in the same append.
		expect(detected?.ts).toBe("2026-05-23T00:00:10.000Z");
		expect((detected?.payloadJson as { pausedAt?: string }).pausedAt).toBe(
			"2026-05-23T00:00:10.000Z",
		);
		expect(respawns).toEqual([]); // pause does NOT respawn
	});

	test("skips conversation runs (they anchor a long-lived pi-chat session)", async () => {
		await seedRunningConversation();
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
		});
		expect(result.paused).toEqual([]);
	});

	test("skips batch runs with no plot_id", async () => {
		await seedRunningBatch(null);
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
		});
		expect(result.paused).toEqual([]);
	});

	test("does nothing when there is no unanswered question_posed", async () => {
		const runId = await seedRunningBatch();
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([
				poseEvent("2026-05-23T00:00:01Z"),
				answerEvent("2026-05-23T00:00:01Z", "answered"),
			]),
			respawn: async () => undefined,
		});
		expect(result.paused).toEqual([]);
		const row = await repos.runs.require(runId);
		expect(row.state).toBe("running");
	});

	test("resumes a paused run on question_answered with the answer in the respawn payload", async () => {
		const runId = await seedRunningBatch();
		// First tick to pause.
		await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});

		// Second tick: the plot log now has an answer.
		const respawns: RespawnInput[] = [];
		const respawn: RespawnFn = async (input) => {
			respawns.push(input);
		};
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([
				poseEvent("2026-05-23T00:00:01Z"),
				answerEvent("2026-05-23T00:00:01Z", "yes please proceed"),
			]),
			respawn,
			now: () => new Date("2026-05-23T00:00:20Z"),
		});

		expect(result.resumed).toEqual([
			{
				runId,
				questionEventId: "2026-05-23T00:00:01Z",
				reason: "answered",
			},
		]);

		const row = await repos.runs.require(runId);
		expect(row.state).toBe("running");
		expect(row.pausedAt).toBeNull();
		expect(row.pausedQuestionEventId).toBeNull();

		const events = await repos.events.listByRun(runId);
		const resumed = events.find((e) => e.kind === PAUSE_RESUMED_KIND);
		expect(resumed).toBeDefined();
		expect((resumed?.payloadJson as { reason?: string }).reason).toBe("answered");
		expect((resumed?.payloadJson as { answer?: string }).answer).toBe("yes please proceed");
		// The envelope `ts` is stamped from the injected `now` clock (warren-96fd),
		// matching the payload's `resumedAt` written in the same append.
		expect(resumed?.ts).toBe("2026-05-23T00:00:20.000Z");
		expect((resumed?.payloadJson as { resumedAt?: string }).resumedAt).toBe(
			"2026-05-23T00:00:20.000Z",
		);

		expect(respawns).toHaveLength(1);
		const r = respawns[0];
		expect(r).toBeDefined();
		if (r === undefined) throw new Error("unreachable");
		expect(r.run.id).toBe(runId);
		expect(r.reason).toEqual({
			kind: "answered",
			questionEventId: "2026-05-23T00:00:01Z",
			answer: "yes please proceed",
		});
	});

	test("respawn carries answer:null when question_answered text is missing", async () => {
		const runId = await seedRunningBatch();
		await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});

		const respawns: RespawnInput[] = [];
		const malformedAnswer = {
			type: "question_answered",
			actor: "user:alice",
			at: "2026-05-23T00:00:02Z",
			data: { question_id: "2026-05-23T00:00:01Z" },
		} as PlotEvent;
		await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z"), malformedAnswer]),
			respawn: async (input) => {
				respawns.push(input);
			},
			now: () => new Date("2026-05-23T00:00:20Z"),
		});

		expect(respawns).toHaveLength(1);
		const r = respawns[0];
		if (r === undefined) throw new Error("unreachable");
		expect(r.run.id).toBe(runId);
		if (r.reason.kind !== "answered") throw new Error("expected answered");
		expect(r.reason.answer).toBeNull();
	});

	test("times out a paused run when pauseTimeoutMs elapses with no answer", async () => {
		const runId = await seedRunningBatch();
		// Use a short budget so the test is deterministic without mocking
		// warrenConfigs end-to-end.
		const fakeWarrenConfigs = {
			get: async () => ({
				defaults: { agent: { pauseTimeoutMs: 1_000 } },
				preview: null,
				triggers: null,
				errors: [],
				warnings: [],
				preferredDefaultsPath: null,
				preferredPreviewPath: null,
			}),
			invalidate: () => undefined,
			clear: () => undefined,
			size: () => 0,
		} as unknown as Parameters<typeof tickPauseDetector>[0]["warrenConfigs"];

		// Pause at t=10s.
		await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
			warrenConfigs: fakeWarrenConfigs,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});
		// Resume tick at t=12s — 2s elapsed, budget 1s ⇒ timeout fires.
		const respawns: RespawnInput[] = [];
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async (input) => {
				respawns.push(input);
			},
			warrenConfigs: fakeWarrenConfigs,
			now: () => new Date("2026-05-23T00:00:12Z"),
		});

		expect(result.resumed).toEqual([
			{ runId, questionEventId: "2026-05-23T00:00:01Z", reason: "timed_out" },
		]);

		const row = await repos.runs.require(runId);
		expect(row.state).toBe("running");
		expect(row.pausedAt).toBeNull();

		const events = await repos.events.listByRun(runId);
		const timedOut = events.find((e) => e.kind === PAUSE_TIMED_OUT_KIND);
		expect(timedOut).toBeDefined();
		// The envelope `ts` is stamped from the injected `now` clock (warren-96fd),
		// matching the payload's `resumedAt` written in the same append.
		expect(timedOut?.ts).toBe("2026-05-23T00:00:12.000Z");
		expect((timedOut?.payloadJson as { resumedAt?: string }).resumedAt).toBe(
			"2026-05-23T00:00:12.000Z",
		);

		expect(respawns).toHaveLength(1);
		const r = respawns[0];
		if (r === undefined) throw new Error("unreachable");
		expect(r.reason.kind).toBe("timed_out");
	});

	test("paused row missing paused_question_event_id is skipped (logged)", async () => {
		// Manually flip a running batch to paused without going through
		// markPaused, then call the tick — the resume pass should skip
		// rather than crash.
		const runId = await seedRunningBatch();
		db.raw.exec(
			`UPDATE runs SET state = 'paused', paused_at = '2026-05-23T00:00:10.000Z' WHERE id = '${runId}'`,
		);
		const warnings: Record<string, unknown>[] = [];
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
			logger: {
				info: () => undefined,
				warn: (obj) => warnings.push(obj),
				error: () => undefined,
			},
			now: () => new Date("2026-05-23T00:00:20Z"),
		});
		expect(result.resumed).toEqual([]);
		expect(warnings.some((w) => w.runId === runId)).toBe(true);
	});

	test("per-run error isolation: a reader throw on one run doesn't block another", async () => {
		const goodRunId = await seedRunningBatch(PLOT_ID);
		const badRunId = await seedRunningBatch("plot-broken1");

		const reader: PlotEventReader = {
			async read({ plotId }) {
				if (plotId === "plot-broken1") throw new Error("plot lib exploded");
				if (plotId === PLOT_ID) return [poseEvent("2026-05-23T00:00:01Z")];
				return [];
			},
		};

		const result = await tickPauseDetector({
			repos,
			plotReader: reader,
			respawn: async () => undefined,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});

		expect(result.paused).toEqual([{ runId: goodRunId, questionEventId: "2026-05-23T00:00:01Z" }]);
		expect(result.errors).toEqual([{ runId: badRunId, reason: "plot lib exploded" }]);

		const good = await repos.runs.require(goodRunId);
		expect(good.state).toBe("paused");
		const bad = await repos.runs.require(badRunId);
		expect(bad.state).toBe("running");
	});

	test("a thrown respawn does not block the resume transition or pause others", async () => {
		const runId = await seedRunningBatch();
		await tickPauseDetector({
			repos,
			plotReader: stubReader([poseEvent("2026-05-23T00:00:01Z")]),
			respawn: async () => undefined,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});

		const errors: Record<string, unknown>[] = [];
		const result = await tickPauseDetector({
			repos,
			plotReader: stubReader([
				poseEvent("2026-05-23T00:00:01Z"),
				answerEvent("2026-05-23T00:00:01Z", "go"),
			]),
			respawn: async () => {
				throw new Error("respawn boom");
			},
			logger: {
				info: () => undefined,
				warn: () => undefined,
				error: (obj) => errors.push(obj),
			},
			now: () => new Date("2026-05-23T00:00:20Z"),
		});

		// Resume still landed in the result + the row + the events table.
		expect(result.resumed).toHaveLength(1);
		const row = await repos.runs.require(runId);
		expect(row.state).toBe("running");
		expect(errors.some((e) => String(e.reason).includes("respawn boom"))).toBe(true);
	});

	test("multiple Plots fan out: each in-flight batch gets its own reader call", async () => {
		const a = await seedRunningBatch("plot-aaaaaaa1");
		const b = await seedRunningBatch("plot-bbbbbbb1");
		const reader = multiPlotReader({
			"plot-aaaaaaa1": [poseEvent("2026-05-23T00:00:01Z")],
			"plot-bbbbbbb1": [
				poseEvent("2026-05-23T00:00:01Z"),
				answerEvent("2026-05-23T00:00:01Z", "fine"),
			],
		});
		const result = await tickPauseDetector({
			repos,
			plotReader: reader,
			respawn: async () => undefined,
			now: () => new Date("2026-05-23T00:00:10Z"),
		});
		expect(result.paused).toEqual([{ runId: a, questionEventId: "2026-05-23T00:00:01Z" }]);
		expect(result.resumed).toEqual([]);
		const rowA = await repos.runs.require(a);
		const rowB = await repos.runs.require(b);
		expect(rowA.state).toBe("paused");
		expect(rowB.state).toBe("running");
	});
});
