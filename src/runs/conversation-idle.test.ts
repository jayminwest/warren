/**
 * Unit tests for the conversation idle-timeout coordinator
 * (warren-005d / LEVERET.md §0.4 / §0.14, pl-d2d9 build-phase 2).
 *
 * Coverage per the seed body:
 *   - an idle conversation's anchoring run finalizes (`running →
 *     succeeded`) once `now - last_activity_at >= idleTimeoutMs`, emitting
 *     a `conversation.idle_finalized` system event on the run.
 *   - a conversation that is NOT yet idle is left untouched.
 *   - per-project `conversation.idleTimeoutMs` override is honored; the
 *     `DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS` fallback applies otherwise.
 *   - no-op / defensive cases (bad timestamp, run no longer `running`).
 *   - per-candidate error isolation so one bad row can't tear down the tick.
 *   - single-flight `bootConversationIdleDetector` wrapper drops overlapping
 *     ticks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	createWarrenConfigCache,
	DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS,
	type LoadedWarrenConfig,
} from "../warren-config/index.ts";
import {
	bootConversationIdleDetector,
	CONVERSATION_IDLE_FINALIZED_KIND,
	type IdleConversationCandidate,
	type IdleConversationReader,
	tickConversationIdleDetector,
} from "./conversation-idle.ts";

const PROJECT_ID = "prj_xxxxxxxxxxxx";
const NOW = new Date("2026-06-06T12:00:00.000Z");

function makeAgentJson() {
	return {
		name: "claude-code",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

function stubReader(candidates: readonly IdleConversationCandidate[]): IdleConversationReader {
	return {
		async read() {
			return candidates;
		},
	};
}

function emptyDefaults(): LoadedWarrenConfig {
	return { defaults: {}, triggers: null, prTemplate: null, errors: [], warnings: [] };
}

describe("tickConversationIdleDetector", () => {
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

	async function seedRunningConversation(): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "<conversation>",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "conversation",
		});
		await repos.runs.markRunning(row.id);
		return row.id;
	}

	function candidate(runId: string, lastActivityAt: string): IdleConversationCandidate {
		return { conversationId: "cnv-1", runId, projectId: PROJECT_ID, lastActivityAt };
	}

	test("finalizes the anchoring run once idle past the default budget", async () => {
		const runId = await seedRunningConversation();
		// last_activity_at is one ms past the default budget ago.
		const lastActivityAt = new Date(
			NOW.getTime() - DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS - 1,
		).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, lastActivityAt)]),
			now: () => NOW,
		});
		expect(result.finalized).toEqual([{ conversationId: "cnv-1", runId }]);
		expect(result.errors).toEqual([]);
		const run = await repos.runs.require(runId);
		expect(run.state).toBe("succeeded");
		const events = await repos.events.listByRun(runId);
		const idle = events.find((e) => e.kind === CONVERSATION_IDLE_FINALIZED_KIND);
		expect(idle).toBeDefined();
		expect((idle?.payloadJson as { conversationId?: string })?.conversationId).toBe("cnv-1");
	});

	test("leaves a not-yet-idle conversation untouched", async () => {
		const runId = await seedRunningConversation();
		// Active one second ago — well within the default budget.
		const lastActivityAt = new Date(NOW.getTime() - 1_000).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, lastActivityAt)]),
			now: () => NOW,
		});
		expect(result.finalized).toEqual([]);
		const run = await repos.runs.require(runId);
		expect(run.state).toBe("running");
	});

	test("honors a per-project conversation.idleTimeoutMs override", async () => {
		const runId = await seedRunningConversation();
		const warrenConfigs = createWarrenConfigCache({
			async load() {
				return {
					defaults: { conversation: { idleTimeoutMs: 60_000 } },
					triggers: null,
					prTemplate: null,
					errors: [],
					warnings: [],
				};
			},
		});
		// Idle for 90s: under the default 20m, but past the 60s override.
		const lastActivityAt = new Date(NOW.getTime() - 90_000).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, lastActivityAt)]),
			warrenConfigs,
			now: () => NOW,
		});
		expect(result.finalized).toHaveLength(1);
		expect((await repos.runs.require(runId)).state).toBe("succeeded");
	});

	test("falls back to the default budget when config load throws", async () => {
		const runId = await seedRunningConversation();
		const warrenConfigs = createWarrenConfigCache({
			async load() {
				throw new Error("boom");
			},
		});
		// Just shy of the default budget — should NOT finalize under fallback.
		const lastActivityAt = new Date(
			NOW.getTime() - DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS + 5_000,
		).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, lastActivityAt)]),
			warrenConfigs,
			now: () => NOW,
		});
		expect(result.finalized).toEqual([]);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("skips a candidate whose run is no longer running", async () => {
		const runId = await seedRunningConversation();
		await repos.runs.finalize(runId, "succeeded");
		const lastActivityAt = new Date(
			NOW.getTime() - DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS - 1,
		).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, lastActivityAt)]),
			now: () => NOW,
		});
		expect(result.finalized).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("skips a candidate with an unparseable last_activity_at", async () => {
		const runId = await seedRunningConversation();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([candidate(runId, "not-a-date")]),
			now: () => NOW,
		});
		expect(result.finalized).toEqual([]);
		expect(result.errors).toEqual([]);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("isolates per-candidate errors and still processes the rest", async () => {
		const goodRun = await seedRunningConversation();
		const lastActivityAt = new Date(
			NOW.getTime() - DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS - 1,
		).toISOString();
		const result = await tickConversationIdleDetector({
			repos,
			reader: stubReader([
				{ conversationId: "cnv-bad", runId: "run_missing", projectId: null, lastActivityAt },
				candidate(goodRun, lastActivityAt),
			]),
			now: () => NOW,
		});
		expect(result.finalized).toEqual([{ conversationId: "cnv-1", runId: goodRun }]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.conversationId).toBe("cnv-bad");
	});

	test("captures a reader failure as a single error", async () => {
		const result = await tickConversationIdleDetector({
			repos,
			reader: {
				async read() {
					throw new Error("reader down");
				},
			},
			now: () => NOW,
		});
		expect(result.finalized).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.conversationId).toBe("<reader.read>");
	});
});

describe("bootConversationIdleDetector", () => {
	test("runOnce drives a tick and tickCount increments", async () => {
		const handle = bootConversationIdleDetector({
			repos: undefined as never,
			reader: stubReader([]),
			tickMs: 1_000,
			disabled: true,
		});
		const result = await handle.runOnce();
		expect(result).toEqual({ finalized: [], errors: [] });
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("drops an overlapping tick (single-flight)", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reader: IdleConversationReader = {
			async read() {
				await gate;
				return [];
			},
		};
		const handle = bootConversationIdleDetector({
			repos: undefined as never,
			reader,
			tickMs: 1_000,
			disabled: true,
		});
		const first = handle.runOnce();
		const second = await handle.runOnce(); // in-flight → dropped → null
		expect(second).toBeNull();
		release();
		await first;
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("config cache integration compiles against the empty-defaults shape", () => {
		// Sanity: emptyDefaults yields a budget-less config the resolver tolerates.
		expect(emptyDefaults().defaults?.conversation).toBeUndefined();
	});
});
