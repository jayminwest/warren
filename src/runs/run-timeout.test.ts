/**
 * Tests for the per-run wall-clock cap (warren-a112): resolution precedence,
 * defensive coercion, deadline evaluation, and the watchdog force-fail it
 * drives.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	coerceDurationCap,
	DURATION_EXCEEDED_KIND,
	evaluateDurationCap,
	resolveDurationOverride,
	resolveRunMaxDurationMinutes,
	withMaxDurationMinutesOverride,
} from "./run-timeout.ts";
import {
	fakeReapResult,
	makeAgentJson,
	makeCancelProvider,
	PROJECT_ID,
} from "./watchdog.test-helpers.ts";
import { tickWatchdog, WATCHDOG_TIMED_OUT_KIND } from "./watchdog.ts";

describe("coerceDurationCap", () => {
	test("accepts positive numbers and numeric strings", () => {
		expect(coerceDurationCap(30)).toBe(30);
		expect(coerceDurationCap(" 45 ")).toBe(45);
	});

	test("fails open on zero, negatives, NaN, and junk", () => {
		for (const raw of [0, -5, Number.NaN, "", "abc", null, undefined, {}]) {
			expect(coerceDurationCap(raw)).toBeNull();
		}
	});
});

describe("resolveDurationOverride", () => {
	test("the dispatch override wins over frontmatter and project default", () => {
		expect(
			resolveDurationOverride({
				overrideMinutes: 10,
				frontmatter: { maxDurationMinutes: 60 },
				projectDefaultMinutes: 90,
			}),
		).toBe(10);
	});

	test("an agent declaration stays in place (no fold) over the project default", () => {
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: 60 },
				projectDefaultMinutes: 90,
			}),
		).toBeUndefined();
	});

	test("a malformed agent value is kept (fails open), not replaced by the default", () => {
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: "soon" },
				projectDefaultMinutes: 90,
			}),
		).toBeUndefined();
	});

	test("the project default applies when the agent declares nothing (or null)", () => {
		expect(resolveDurationOverride({ frontmatter: {}, projectDefaultMinutes: 90 })).toBe(90);
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: null },
				projectDefaultMinutes: 90,
			}),
		).toBe(90);
		expect(resolveDurationOverride({ frontmatter: {} })).toBeUndefined();
	});

	test("the folded value is what enforcement reads back", () => {
		const agent = withMaxDurationMinutesOverride(makeAgentJson(), 15);
		expect(resolveRunMaxDurationMinutes(agent)).toBe(15);
		expect(withMaxDurationMinutesOverride(makeAgentJson(), undefined).frontmatter).toEqual({});
		expect(resolveRunMaxDurationMinutes(null)).toBeNull();
		expect(resolveRunMaxDurationMinutes({ frontmatter: [] })).toBeNull();
	});
});

describe("evaluateDurationCap", () => {
	const capped = { frontmatter: { maxDurationMinutes: 30 } };

	test("reports the overrun once now reaches startedAt + cap", () => {
		const run = { startedAt: "2026-06-05T00:00:00.000Z", renderedAgentJson: capped };
		expect(evaluateDurationCap(run, new Date("2026-06-05T00:29:59Z"))).toBeNull();
		expect(evaluateDurationCap(run, new Date("2026-06-05T00:30:00Z"))).toEqual({
			maxDurationMinutes: 30,
			elapsedMs: 30 * 60_000,
			deadlineAt: "2026-06-05T00:30:00.000Z",
		});
	});

	test("never fires without a cap or a parseable startedAt", () => {
		const late = new Date("2027-01-01T00:00:00Z");
		expect(
			evaluateDurationCap({ startedAt: "2026-06-05T00:00:00Z", renderedAgentJson: {} }, late),
		).toBeNull();
		expect(evaluateDurationCap({ startedAt: null, renderedAgentJson: capped }, late)).toBeNull();
		expect(evaluateDurationCap({ startedAt: "garbage", renderedAgentJson: capped }, late)).toBe(
			null,
		);
	});
});

describe("tickWatchdog duration cap", () => {
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
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedRunning(maxDurationMinutes: number | undefined): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: withMaxDurationMinutesOverride(makeAgentJson(), maxDurationMinutes),
			trigger: "manual",
			mode: "batch",
		});
		await repos.runs.markRunning(row.id, new Date("2026-06-05T00:00:00Z"));
		await repos.runs.attachBurrow(row.id, { sandboxId: "bur_1", sandboxRunId: "run_b1" });
		// A fresh event keeps the heartbeat alive: only the wall clock can trip.
		await repos.events.append({
			runId: row.id,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:39:30.000Z",
			kind: "assistant",
			stream: "stdout",
			payload: {},
		});
		return row.id;
	}

	async function tick(runAt: string) {
		const cancels: string[] = [];
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider(cancels),
			heartbeatTimeoutMs: 45 * 60_000,
			now: () => new Date(runAt),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		return { result, cancels, reapCalls };
	}

	test("force-fails a busy run past its cap as timed_out with a duration.exceeded event", async () => {
		const runId = await seedRunning(30);
		const { result, cancels, reapCalls } = await tick("2026-06-05T00:40:00Z");

		expect(result.durationExceeded).toEqual([{ runId, elapsedMs: 40 * 60_000 }]);
		expect(result.timedOut).toEqual([]);
		expect(cancels).toEqual(["run_b1"]);
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.outcome).toBe("failed");
		expect(reapCalls[0]?.failureReason).toBe("timed_out");

		const events = await repos.events.listByRun(runId);
		expect(events.some((e) => e.kind === WATCHDOG_TIMED_OUT_KIND)).toBe(false);
		const exceeded = events.find((e) => e.kind === DURATION_EXCEEDED_KIND);
		expect(exceeded?.stream).toBe("system");
		expect(exceeded?.payloadJson).toEqual({
			maxDurationMinutes: 30,
			elapsedMs: 40 * 60_000,
			deadlineAt: "2026-06-05T00:30:00.000Z",
			sandboxRunId: "run_b1",
		});
	});

	test("leaves a capped run inside its deadline, and an uncapped run, alone", async () => {
		await seedRunning(60);
		await seedRunning(undefined);
		const { result, reapCalls } = await tick("2026-06-05T00:40:00Z");
		expect(result.durationExceeded).toEqual([]);
		expect(reapCalls).toHaveLength(0);
	});
});
