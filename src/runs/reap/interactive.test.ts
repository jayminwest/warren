import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import { captureInteractiveReply, extractFinalAssistantMessage } from "./interactive.ts";
import type { ReapRunInput } from "./types.ts";

function ev(over: Partial<EventRow>): EventRow {
	return {
		id: 0,
		runId: "run_x",
		burrowEventSeq: 0,
		ts: "2026-05-29T00:00:00.000Z",
		kind: "text",
		stream: "stdout",
		payloadJson: {},
		...over,
	} as EventRow;
}

describe("extractFinalAssistantMessage", () => {
	test("returns null when there are no text events", () => {
		expect(extractFinalAssistantMessage([])).toBeNull();
		expect(
			extractFinalAssistantMessage([ev({ kind: "tool_use", payloadJson: { name: "bash" } })]),
		).toBeNull();
	});

	test("concatenates trailing stdout text blocks", () => {
		const got = extractFinalAssistantMessage([
			ev({ kind: "text", payloadJson: { text: "Hello " } }),
			ev({ kind: "text", payloadJson: { text: "world" } }),
		]);
		expect(got).toBe("Hello world");
	});

	test("only captures the final assistant turn (after the last tool event)", () => {
		const got = extractFinalAssistantMessage([
			ev({ kind: "text", payloadJson: { text: "first turn" } }),
			ev({ kind: "tool_use", payloadJson: { name: "bash" } }),
			ev({ kind: "tool_result", payloadJson: { ok: true } }),
			ev({ kind: "text", payloadJson: { text: "final reply" } }),
		]);
		expect(got).toBe("final reply");
	});

	test("ignores non-stdout and non-text events, tolerates content fallback", () => {
		const got = extractFinalAssistantMessage([
			ev({ kind: "thinking", payloadJson: { text: "hmm" } }),
			ev({ kind: "user_message", stream: "system", payloadJson: { content: "hi" } }),
			ev({ kind: "text", payloadJson: { content: "via content field" } }),
		]);
		expect(got).toBe("via content field");
	});

	test("returns null when the final turn is whitespace-only", () => {
		const got = extractFinalAssistantMessage([ev({ kind: "text", payloadJson: { text: "   " } })]);
		expect(got).toBeNull();
	});
});

describe("captureInteractiveReply", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	async function makeRun(mode: "batch" | "interactive") {
		return repos.runs.create({
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "x",
			renderedAgentJson: { name: "brainstorm" },
			trigger: "interactive",
			mode,
			plotId: "plot-aaa",
		});
	}

	function reapInput(): ReapRunInput {
		return { repos } as unknown as ReapRunInput;
	}

	test("no-op for non-interactive runs", async () => {
		const run = await makeRun("batch");
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 1,
			ts: "2026-05-29T00:00:00.000Z",
			kind: "text",
			stream: "stdout",
			payload: { text: "hi" },
		});
		expect(await captureInteractiveReply({ run, input: reapInput(), now: new Date() })).toBeNull();
	});

	test("appends agent_message with the final assistant reply", async () => {
		const run = await makeRun("interactive");
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 1,
			ts: "2026-05-29T00:00:00.000Z",
			kind: "text",
			stream: "stdout",
			payload: { text: "the reply" },
		});
		const row = await captureInteractiveReply({ run, input: reapInput(), now: new Date() });
		expect(row).not.toBeNull();
		expect(row?.kind).toBe("agent_message");
		const payload = row?.payloadJson as { actor: string; content: string };
		expect(payload.content).toBe("the reply");
		expect(payload.actor).toBe(`agent:brainstorm:${run.id}`);
	});

	test("no-op when the run produced no assistant text", async () => {
		const run = await makeRun("interactive");
		expect(await captureInteractiveReply({ run, input: reapInput(), now: new Date() })).toBeNull();
	});
});
