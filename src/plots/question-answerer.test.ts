/**
 * Unit tests for `assertQuestionAnswerable` (warren-e1ac / pl-9d6a
 * step 12) and the production `defaultPlotQuestionAnswerer`'s
 * round-trip behavior via a real `@os-eco/plot-cli` `.plot/` fixture.
 *
 * The handler-edge concurrency invariant — that the targeted
 * `question_posed` exists AND has no subsequent `question_answered`
 * referencing it — lives in warren (the lib guarantees neither half),
 * so we pin it at this layer rather than through the HTTP fetches.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlotEvent } from "@os-eco/plot-cli";
import { AgentPlotClient, UserPlotClient } from "../plot-client/index.ts";
import { PlotQuestionAlreadyAnsweredError, PlotQuestionNotFoundError } from "./errors.ts";
import { assertQuestionAnswerable, defaultPlotQuestionAnswerer } from "./question-answerer.ts";

function posed(at: string): PlotEvent {
	return {
		type: "question_posed",
		actor: "agent:bot:r1",
		at,
		data: { text: "which db?", blocking: true },
	};
}

function answered(at: string, qid: string): PlotEvent {
	return {
		type: "question_answered",
		actor: "user:alice",
		at,
		data: { question_id: qid, text: "postgres" },
	};
}

describe("assertQuestionAnswerable", () => {
	test("passes when the question_posed is present and unanswered", () => {
		const events: PlotEvent[] = [posed("2026-05-18T04:00:00Z")];
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", events)).not.toThrow();
	});

	test("throws PlotQuestionNotFoundError when no question_posed has the targeted at", () => {
		const events: PlotEvent[] = [posed("2026-05-18T05:00:00Z")];
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", events)).toThrow(
			PlotQuestionNotFoundError,
		);
	});

	test("throws PlotQuestionNotFoundError on empty event log", () => {
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", [])).toThrow(
			PlotQuestionNotFoundError,
		);
	});

	test("throws PlotQuestionAlreadyAnsweredError when a later question_answered references it", () => {
		const events: PlotEvent[] = [
			posed("2026-05-18T04:00:00Z"),
			answered("2026-05-18T04:05:00Z", "2026-05-18T04:00:00Z"),
		];
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", events)).toThrow(
			PlotQuestionAlreadyAnsweredError,
		);
	});

	test("permits answering when only OTHER questions have answers", () => {
		const events: PlotEvent[] = [
			posed("2026-05-18T04:00:00Z"),
			posed("2026-05-18T04:10:00Z"),
			answered("2026-05-18T04:15:00Z", "2026-05-18T04:10:00Z"),
		];
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", events)).not.toThrow();
	});

	test("ignores question_answered events that PRECEDE the targeted question_posed", () => {
		// Pathological but library doesn't forbid out-of-order appends —
		// only later question_answered referencing this question counts.
		const events: PlotEvent[] = [
			answered("2026-05-18T03:00:00Z", "2026-05-18T04:00:00Z"),
			posed("2026-05-18T04:00:00Z"),
		];
		expect(() => assertQuestionAnswerable("pt-x", "2026-05-18T04:00:00Z", events)).not.toThrow();
	});
});

describe("defaultPlotQuestionAnswerer", () => {
	test("round-trip: appends question_answered and returns the new event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-q-answer-"));
		try {
			// Seed a Plot via UserPlotClient, then post the question_posed
			// event via AgentPlotClient — per SPEC §6, question_posed is
			// agent-only at the ACL layer.
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Q" });
			seedClient.close();

			const agentClient = new AgentPlotClient({
				dir,
				actor: {
					kind: "agent",
					name: "bot",
					runId: "r1",
					raw: "agent:bot:r1",
				},
			});
			const agentHandle = agentClient.get(seeded.id);
			const posedEv = await agentHandle.append({
				type: "question_posed",
				data: { text: "which db?", blocking: true },
			});
			agentClient.close();

			const result = await defaultPlotQuestionAnswerer.answer({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				eventId: posedEv.at,
				answer: "postgres",
			});

			expect(result.event.type).toBe("question_answered");
			expect((result.event.data as { question_id?: string }).question_id).toBe(posedEv.at);
			expect((result.event.data as { text?: string }).text).toBe("postgres");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects with PlotQuestionNotFoundError when no question_posed matches eventId", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-q-nf-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Q" });
			seedClient.close();

			await expect(
				defaultPlotQuestionAnswerer.answer({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					eventId: "2026-05-18T04:00:00Z",
					answer: "y",
				}),
			).rejects.toBeInstanceOf(PlotQuestionNotFoundError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects with PlotQuestionAlreadyAnsweredError on second answer (seed-pinned invariant)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-q-already-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Q" });
			seedClient.close();

			const agentClient = new AgentPlotClient({
				dir,
				actor: {
					kind: "agent",
					name: "bot",
					runId: "r1",
					raw: "agent:bot:r1",
				},
			});
			const agentHandle = agentClient.get(seeded.id);
			const posedEv = await agentHandle.append({
				type: "question_posed",
				data: { text: "which db?", blocking: true },
			});
			agentClient.close();

			// First answer lands.
			await defaultPlotQuestionAnswerer.answer({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				eventId: posedEv.at,
				answer: "postgres",
			});

			// Second answer is rejected.
			await expect(
				defaultPlotQuestionAnswerer.answer({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					eventId: posedEv.at,
					answer: "sqlite",
				}),
			).rejects.toBeInstanceOf(PlotQuestionAlreadyAnsweredError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
