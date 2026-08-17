/**
 * Tests for the read-time cost hydrator (warren-ab18).
 *
 * Targets the gap between "events landed" and "row got finalised" — a
 * terminal run with usage events but null cost columns should come
 * back from these helpers with cost populated, while non-terminal or
 * already-hydrated rows pass through unchanged.
 */

import { describe, expect, test } from "bun:test";
import type { RunRow } from "../db/schema.ts";
import { hydrateRunsUsage, hydrateRunUsage, type UsageEventsFetcher } from "./usage-hydrate.ts";

function row(over: Partial<RunRow> & { id: string; state: RunRow["state"] }): RunRow {
	return {
		agentName: "claude-code",
		projectId: "prj_1",
		sandboxId: null,
		sandboxRunId: null,
		workerId: null,
		seedId: null,
		renderedAgentJson: null,
		failureReason: null,
		startedAt: null,
		endedAt: null,
		prompt: "",
		trigger: "manual",
		prUrl: null,
		costUsd: null,
		tokensInput: null,
		tokensOutput: null,
		tokensCacheRead: null,
		tokensCacheWrite: null,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		previewFailureMessage: null,
		...over,
	} as RunRow;
}

function claudeResultEvent(runId: string, costUsd: number, tokensInput: number) {
	return {
		runId,
		kind: "state_change",
		stream: "system" as const,
		payloadJson: {
			type: "result",
			total_cost_usd: costUsd,
			usage: {
				input_tokens: tokensInput,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	};
}

function fetcher(
	rows: readonly { runId: string; kind: string; stream: string | null; payloadJson: unknown }[],
): UsageEventsFetcher & { calls: number; lastIds: readonly string[] } {
	const wrapper = {
		calls: 0,
		lastIds: [] as readonly string[],
		async listUsageEvents(runIds: readonly string[]) {
			wrapper.calls += 1;
			wrapper.lastIds = runIds;
			return rows.filter((r) => runIds.includes(r.runId));
		},
	};
	return wrapper;
}

describe("hydrateRunsUsage", () => {
	test("overlays cost on terminal rows with null costUsd", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const out = await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events);
		expect(out[0]?.costUsd).toBeCloseTo(0.42);
		expect(out[0]?.tokensInput).toBe(1200);
	});

	test("passes non-terminal rows through unchanged", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const out = await hydrateRunsUsage([row({ id: "run_a", state: "running" })], events);
		expect(out[0]?.costUsd).toBeNull();
		// Running rows aren't candidates, so we never even ask for events.
		expect(events.calls).toBe(0);
	});

	test("leaves rows whose cost is already set untouched", async () => {
		const events = fetcher([claudeResultEvent("run_a", 9.99, 9999)]);
		const out = await hydrateRunsUsage(
			[row({ id: "run_a", state: "succeeded", costUsd: 0.5, tokensInput: 100 })],
			events,
		);
		expect(out[0]?.costUsd).toBe(0.5);
		expect(out[0]?.tokensInput).toBe(100);
		expect(events.calls).toBe(0);
	});

	test("batches all candidates into one fetch", async () => {
		const events = fetcher([
			claudeResultEvent("run_a", 0.1, 10),
			claudeResultEvent("run_b", 0.2, 20),
			claudeResultEvent("run_c", 0.3, 30),
		]);
		const out = await hydrateRunsUsage(
			[
				row({ id: "run_a", state: "succeeded" }),
				row({ id: "run_b", state: "failed" }),
				row({ id: "run_c", state: "cancelled" }),
			],
			events,
		);
		expect(events.calls).toBe(1);
		expect(events.lastIds.length).toBe(3);
		expect(out[0]?.costUsd).toBeCloseTo(0.1);
		expect(out[1]?.costUsd).toBeCloseTo(0.2);
		expect(out[2]?.costUsd).toBeCloseTo(0.3);
	});

	test("leaves the row unchanged when no usage events landed", async () => {
		// Captures the seed's acceptance edge: a terminal run with zero
		// usage-shaped events keeps a null cost (no zero-write, parity
		// with the bridge's `acc.seen === false` skip).
		const events = fetcher([]);
		const out = await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events);
		expect(out[0]?.costUsd).toBeNull();
		expect(out[0]?.tokensInput).toBeNull();
	});

	test("preserves order of input rows", async () => {
		const events = fetcher([
			claudeResultEvent("run_b", 0.5, 50),
			claudeResultEvent("run_a", 0.1, 10),
		]);
		const out = await hydrateRunsUsage(
			[row({ id: "run_a", state: "succeeded" }), row({ id: "run_b", state: "failed" })],
			events,
		);
		expect(out[0]?.id).toBe("run_a");
		expect(out[1]?.id).toBe("run_b");
		expect(out[0]?.costUsd).toBeCloseTo(0.1);
		expect(out[1]?.costUsd).toBeCloseTo(0.5);
	});
});

describe("hydrateRunUsage", () => {
	test("hydrates a single row when it's a candidate", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.7, 700)]);
		const out = await hydrateRunUsage(row({ id: "run_a", state: "failed" }), events);
		expect(out.costUsd).toBeCloseTo(0.7);
	});

	test("passes a non-candidate row through unchanged", async () => {
		const events = fetcher([]);
		const input = row({ id: "run_a", state: "queued" });
		const out = await hydrateRunUsage(input, events);
		expect(out).toBe(input);
	});
});
