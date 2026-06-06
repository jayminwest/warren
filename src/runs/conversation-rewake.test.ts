/**
 * Unit tests for the conversation re-wake primitive (warren-6ccf /
 * LEVERET.md §0.4 / §0.2, pl-d2d9 build-phase 2).
 *
 * Coverage per the seed body:
 *   - re-waking an `active` conversation whose anchoring run is terminal
 *     spawns a fresh mode:"conversation" run seeded with the FULL prior
 *     transcript, rotates `anchoring_run_id` to the new run, and emits a
 *     `conversation.rewake_replayed` system event carrying the prior run id +
 *     replayed message count.
 *   - no dependence on the old burrow / `.pi/sessions`: the new prompt is
 *     built purely from the DB transcript handed back by the reader seam.
 *   - guard rails: missing conversation (NotFound), closed conversation,
 *     deleted project, missing anchoring pointer, missing prior run
 *     (NotFound), and a still-live (non-terminal) anchoring run all refuse
 *     without spawning.
 *   - `buildRewakePrompt` renders the transcript deterministically and
 *     tolerates an empty transcript.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import {
	buildRewakePrompt,
	CONVERSATION_REWAKE_REPLAYED_KIND,
	type ConversationAnchorRotator,
	type ConversationRecord,
	type ConversationRewakeReader,
	type RewakeSpawner,
	rewakeConversation,
	type TranscriptMessage,
} from "./conversation-rewake.ts";
import type { SpawnRunInput, SpawnRunResult } from "./spawn/index.ts";

const PROJECT_ID = "prj_xxxxxxxxxxxx";
const CONVERSATION_ID = "cnv_aaaaaaaaaaaa";
const PLOT_ID = "plot-rewake01";
const NOW = new Date("2026-06-06T12:00:00.000Z");

function makeAgentJson() {
	return {
		name: "leveret",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

function stubReader(
	conversation: ConversationRecord | null,
	transcript: readonly TranscriptMessage[] = [],
): ConversationRewakeReader {
	return {
		async readConversation() {
			return conversation;
		},
		async readTranscript() {
			return transcript;
		},
	};
}

describe("rewakeConversation", () => {
	let db: WarrenDb;
	let repos: Repos;
	let rotateCalls: Array<{ conversationId: string; newRunId: string; now: Date }>;
	let rotator: ConversationAnchorRotator;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "leveret", renderedJson: makeAgentJson() });
		await repos.projects.create({
			id: PROJECT_ID,
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		rotateCalls = [];
		rotator = {
			async rotate(input) {
				rotateCalls.push(input);
			},
		};
	});

	afterEach(async () => {
		await db.close();
	});

	/** Seed a prior anchoring run, finalized into a terminal state. */
	async function seedPriorRun(state: RunTerminalState = "succeeded"): Promise<string> {
		const row = await repos.runs.create({
			agentName: "leveret",
			projectId: PROJECT_ID,
			prompt: "<conversation>",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "conversation",
			plotId: PLOT_ID,
		});
		await repos.runs.markRunning(row.id);
		await repos.runs.finalize(row.id, state, NOW);
		return row.id;
	}

	/** A spawner that creates a real running conversation run and records its input. */
	function recordingSpawner(calls: SpawnRunInput[]): RewakeSpawner {
		return async (spawnInput) => {
			calls.push(spawnInput);
			const row = await repos.runs.create({
				agentName: spawnInput.agentName,
				projectId: spawnInput.projectId,
				prompt: spawnInput.prompt,
				renderedAgentJson: makeAgentJson(),
				trigger: spawnInput.trigger ?? "rewake",
				mode: "conversation",
				...(spawnInput.plotId !== undefined ? { plotId: spawnInput.plotId } : {}),
			});
			await repos.runs.markRunning(row.id);
			return { run: row } as unknown as SpawnRunResult;
		};
	}

	function activeConversation(anchoringRunId: string | null): ConversationRecord {
		return {
			id: CONVERSATION_ID,
			projectId: PROJECT_ID,
			plotId: PLOT_ID,
			anchoringRunId,
			status: "active",
		};
	}

	test("throws NotFoundError when the conversation does not exist", async () => {
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader(null),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
		expect(rotateCalls).toHaveLength(0);
	});

	test("refuses a closed conversation", async () => {
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader({ ...activeConversation("run_x"), status: "closed" }),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("refuses a conversation whose project was deleted", async () => {
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader({ ...activeConversation("run_x"), projectId: null }),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("refuses a conversation with no anchoring run pointer", async () => {
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader(activeConversation(null)),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the anchoring run row is gone", async () => {
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader(activeConversation("run_missing")),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("refuses re-wake when the anchoring run is still live (non-terminal)", async () => {
		const row = await repos.runs.create({
			agentName: "leveret",
			projectId: PROJECT_ID,
			prompt: "<conversation>",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "conversation",
			plotId: PLOT_ID,
		});
		await repos.runs.markRunning(row.id);
		const calls: SpawnRunInput[] = [];
		await expect(
			rewakeConversation({
				repos,
				burrowClientPool: undefined as never,
				conversationId: CONVERSATION_ID,
				reader: stubReader(activeConversation(row.id)),
				rotator,
				spawner: recordingSpawner(calls),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(rotateCalls).toHaveLength(0);
	});

	test("happy path: spawns a fresh run replaying the full transcript and rotates the anchor", async () => {
		const priorId = await seedPriorRun();
		const transcript: TranscriptMessage[] = [
			{ seq: 1, role: "user", content: "build me a feature" },
			{ seq: 2, role: "assistant", content: "sure, what shape?" },
			{ seq: 3, role: "user", content: "a CLI flag" },
		];
		const calls: SpawnRunInput[] = [];
		const result = await rewakeConversation({
			repos,
			burrowClientPool: undefined as never,
			conversationId: CONVERSATION_ID,
			reader: stubReader(activeConversation(priorId), transcript),
			rotator,
			spawner: recordingSpawner(calls),
			now: () => NOW,
		});

		// A fresh conversation run was spawned with the inherited agent + plot.
		expect(calls).toHaveLength(1);
		const spawnInput = calls[0];
		expect(spawnInput?.mode).toBe("conversation");
		expect(spawnInput?.agentName).toBe("leveret");
		expect(spawnInput?.projectId).toBe(PROJECT_ID);
		expect(spawnInput?.plotId).toBe(PLOT_ID);
		expect(spawnInput?.trigger).toBe("rewake");
		// The prompt replays the full transcript verbatim — no burrow/session dep.
		expect(spawnInput?.prompt).toContain('<conversation_transcript count="3">');
		expect(spawnInput?.prompt).toContain("build me a feature");
		expect(spawnInput?.prompt).toContain("a CLI flag");

		// anchoring_run_id rotated to the new run.
		expect(result.replayedMessageCount).toBe(3);
		expect(result.priorRun.id).toBe(priorId);
		const newRunId = result.turn.run.id;
		expect(newRunId).not.toBe(priorId);
		expect(rotateCalls).toEqual([{ conversationId: CONVERSATION_ID, newRunId, now: NOW }]);

		// A rewake_replayed trail landed on the NEW run.
		const events = await repos.events.listByRun(newRunId);
		const replay = events.find((e) => e.kind === CONVERSATION_REWAKE_REPLAYED_KIND);
		expect(replay).toBeDefined();
		const payload = replay?.payloadJson as {
			priorRunId?: string;
			replayedMessageCount?: number;
			conversationId?: string;
		};
		expect(payload?.priorRunId).toBe(priorId);
		expect(payload?.replayedMessageCount).toBe(3);
		expect(payload?.conversationId).toBe(CONVERSATION_ID);
	});

	test("re-wakes a terminal-failed anchoring run too (any terminal state qualifies)", async () => {
		const priorId = await seedPriorRun("failed");
		const calls: SpawnRunInput[] = [];
		const result = await rewakeConversation({
			repos,
			burrowClientPool: undefined as never,
			conversationId: CONVERSATION_ID,
			reader: stubReader(activeConversation(priorId), [{ seq: 1, role: "user", content: "hi" }]),
			rotator,
			spawner: recordingSpawner(calls),
			now: () => NOW,
		});
		expect(calls).toHaveLength(1);
		expect(result.replayedMessageCount).toBe(1);
		expect(rotateCalls).toHaveLength(1);
	});

	test("re-wake with an empty transcript still spawns a fresh session", async () => {
		const priorId = await seedPriorRun();
		const calls: SpawnRunInput[] = [];
		const result = await rewakeConversation({
			repos,
			burrowClientPool: undefined as never,
			conversationId: CONVERSATION_ID,
			reader: stubReader(activeConversation(priorId), []),
			rotator,
			spawner: recordingSpawner(calls),
			now: () => NOW,
		});
		expect(calls).toHaveLength(1);
		expect(result.replayedMessageCount).toBe(0);
		expect(calls[0]?.prompt).toContain('<conversation_transcript count="0">');
	});
});

describe("buildRewakePrompt", () => {
	test("renders each transcript message with its seq + role", () => {
		const out = buildRewakePrompt([
			{ seq: 1, role: "user", content: "hello" },
			{ seq: 2, role: "assistant", content: "hi there" },
			{ seq: 3, role: "tool", content: '{"name":"propose_intent"}' },
		]);
		expect(out).toContain('<conversation_transcript count="3">');
		expect(out).toContain('<message seq="1" role="user">');
		expect(out).toContain("hello");
		expect(out).toContain('<message seq="2" role="assistant">');
		expect(out).toContain('<message seq="3" role="tool">');
		expect(out).toContain('{"name":"propose_intent"}');
		expect(out).toContain("</conversation_transcript>");
	});

	test("tolerates an empty transcript", () => {
		const out = buildRewakePrompt([]);
		expect(out).toContain('<conversation_transcript count="0">');
		expect(out).toContain("</conversation_transcript>");
	});
});
