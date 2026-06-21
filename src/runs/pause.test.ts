/**
 * Unit tests for the pause detector (pl-0344 step 5 / warren-2976).
 *
 * Coverage per the seed body:
 *   - pause detection (`running → paused`) on an unanswered
 *     `question_posed` for a batch run carrying a `plot_id`.
 *   - resume on `question_answered` (`paused → running` + respawn with
 *     the answer text folded into the seam input).
 *   - timeout resume (`paused → running` + respawn with `timed_out`
 *     reason) once `agent.pauseTimeoutMs` has elapsed since `paused_at`.
 *   - no-op cases (conversation runs, runs without a `plot_id`, paused
 *     row missing `paused_question_event_id`, no unanswered question).
 *   - per-run error isolation so one bad row can't tear down the tick.
 *   - single-flight `bootPauseDetector` wrapper drops overlapping
 *     ticks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	answerEvent,
	makeAgentJson,
	PLOT_ID,
	PROJECT_ID,
	poseEvent,
	stubReader,
} from "./pause.test-helpers.ts";
import {
	bootPauseDetector,
	findAnswerFor,
	type PlotEventReader,
	pickUnansweredQuestion,
} from "./pause.ts";

describe("pickUnansweredQuestion", () => {
	test("returns null on empty event log", () => {
		expect(pickUnansweredQuestion([])).toBeNull();
	});

	test("returns the at of an unanswered question", () => {
		expect(pickUnansweredQuestion([poseEvent("2026-05-23T00:00:01Z")])).toBe(
			"2026-05-23T00:00:01Z",
		);
	});

	test("returns null when the question has been answered", () => {
		const events = [
			poseEvent("2026-05-23T00:00:01Z"),
			answerEvent("2026-05-23T00:00:01Z", "go for it"),
		];
		expect(pickUnansweredQuestion(events)).toBeNull();
	});

	test("returns the earliest unanswered question when two are open", () => {
		const events = [poseEvent("2026-05-23T00:00:01Z"), poseEvent("2026-05-23T00:00:02Z")];
		expect(pickUnansweredQuestion(events)).toBe("2026-05-23T00:00:01Z");
	});

	test("skips an answered earlier question and surfaces the next open one", () => {
		const events = [
			poseEvent("2026-05-23T00:00:01Z"),
			answerEvent("2026-05-23T00:00:01Z", "first answer"),
			poseEvent("2026-05-23T00:00:02Z"),
		];
		expect(pickUnansweredQuestion(events)).toBe("2026-05-23T00:00:02Z");
	});

	test("tolerates a question_answered with no question_id", () => {
		const events = [
			poseEvent("2026-05-23T00:00:01Z"),
			{
				type: "question_answered",
				actor: "user:alice",
				at: "2026-05-23T00:00:02Z",
				data: {},
			} as PlotEvent,
		];
		expect(pickUnansweredQuestion(events)).toBe("2026-05-23T00:00:01Z");
	});
});

describe("findAnswerFor", () => {
	test("returns the matching question_answered event", () => {
		const events = [
			poseEvent("2026-05-23T00:00:01Z"),
			answerEvent("2026-05-23T00:00:01Z", "go for it"),
		];
		const a = findAnswerFor(events, "2026-05-23T00:00:01Z");
		expect(a).not.toBeNull();
		expect((a?.data as { text?: string })?.text).toBe("go for it");
	});

	test("returns null when no answer references the question", () => {
		expect(findAnswerFor([poseEvent("2026-05-23T00:00:01Z")], "2026-05-23T00:00:01Z")).toBeNull();
	});

	test("ignores answers referencing a different question_id", () => {
		const events = [
			poseEvent("2026-05-23T00:00:01Z"),
			answerEvent("2026-05-23T00:00:02Z", "answer to other"),
		];
		expect(findAnswerFor(events, "2026-05-23T00:00:01Z")).toBeNull();
	});
});

describe("bootPauseDetector", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
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

	test("disabled handle never fires the tick callback", async () => {
		const handle = bootPauseDetector({
			repos,
			plotReader: stubReader([]),
			respawn: async () => undefined,
			tickMs: 10,
			disabled: true,
			setInterval: () => {
				throw new Error("should not setInterval when disabled");
			},
		});
		await handle.stop();
		expect(handle.tickCount()).toBe(0);
	});

	test("runOnce executes the tick and increments tickCount", async () => {
		const handle = bootPauseDetector({
			repos,
			plotReader: stubReader([]),
			respawn: async () => undefined,
			tickMs: 60_000,
			setInterval: () => ({}),
			clearInterval: () => undefined,
		});
		const result = await handle.runOnce();
		expect(result).not.toBeNull();
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("single-flight: overlapping calls are dropped", async () => {
		let release: () => void = () => undefined;
		const blocker = new Promise<void>((res) => {
			release = res;
		});
		const reader: PlotEventReader = {
			async read() {
				await blocker;
				return [];
			},
		};
		const handle = bootPauseDetector({
			repos,
			plotReader: reader,
			respawn: async () => undefined,
			tickMs: 60_000,
			setInterval: () => ({}),
			clearInterval: () => undefined,
		});
		// Seed a running batch so the tick actually invokes the reader.
		await repos.agents.upsert({ name: "claude-code", renderedJson: makeAgentJson() });
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "x",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
			plotId: PLOT_ID,
		});
		await repos.runs.markRunning(row.id);

		const first = handle.runOnce();
		const second = await handle.runOnce(); // should be dropped
		expect(second).toBeNull();
		release();
		await first;
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});
});
