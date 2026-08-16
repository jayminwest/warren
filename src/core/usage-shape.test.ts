/**
 * Tests for the typed per-runtime usage readers (warren-db2e). These
 * pin the shape declarations in `usage-shape.ts` — the single site of
 * usage-shape knowledge the accumulators in
 * `src/runs/usage-aggregate.ts` consume. Cross-envelope aggregation
 * (pi-wins tiebreak included) stays pinned by
 * `usage-aggregate.test.ts`, `budget.test.ts`, `stats.test.ts`, and
 * `usage-hydrate.test.ts`, unmodified.
 */

import { describe, expect, test } from "bun:test";
import { extractAgentEventEnvelope } from "./event-envelope.ts";
import { readUsage, USAGE_SHAPES, usageShapeFor } from "./usage-shape.ts";
import { KNOWN_RUNTIME_IDS, type RuntimeId } from "./wire.ts";

function envelopeFor(payload: unknown) {
	const env = extractAgentEventEnvelope({ kind: "state_change", stream: "system", payload });
	if (env === null) throw new Error("test payload failed the envelope gates");
	return env;
}

const PI_TURN_END = {
	type: "turn_end",
	message: {
		usage: {
			input: 100,
			output: 25,
			cacheRead: 10,
			cacheWrite: 5,
			cost: { total: 0.001 },
		},
	},
};

const CLAUDE_RESULT = {
	type: "result",
	total_cost_usd: 0.0421,
	usage: {
		input_tokens: 1200,
		output_tokens: 400,
		cache_read_input_tokens: 300,
		cache_creation_input_tokens: 50,
	},
};

describe("USAGE_SHAPES", () => {
	test("declares shapes keyed off RuntimeId for pi and claude-code only", () => {
		expect(Object.keys(USAGE_SHAPES).sort()).toEqual(["claude-code", "pi"]);
		for (const id of Object.keys(USAGE_SHAPES)) {
			expect(KNOWN_RUNTIME_IDS as readonly string[]).toContain(id);
		}
	});

	test("every known runtime id resolves through usageShapeFor without throwing", () => {
		for (const id of KNOWN_RUNTIME_IDS) {
			const shape = usageShapeFor(id);
			if (shape !== null) expect(shape.runtime).toBe(id);
		}
		expect(usageShapeFor("pi")?.mode).toBe("sum");
		expect(usageShapeFor("claude-code")?.mode).toBe("assign");
	});
});

describe("readUsage", () => {
	test("reads pi turn_end usage fields", () => {
		expect(readUsage(envelopeFor(PI_TURN_END))).toEqual({
			costUsd: 0.001,
			tokensInput: 100,
			tokensOutput: 25,
			tokensCacheRead: 10,
			tokensCacheWrite: 5,
		});
	});

	test("reads claude-code result usage fields", () => {
		expect(readUsage(envelopeFor(CLAUDE_RESULT))).toEqual({
			costUsd: 0.0421,
			tokensInput: 1200,
			tokensOutput: 400,
			tokensCacheRead: 300,
			tokensCacheWrite: 50,
		});
	});

	test("returns null for envelopes no shape claims", () => {
		expect(readUsage(envelopeFor({ type: "agent_end" }))).toBeNull();
		expect(readUsage(envelopeFor({ type: "message_end", message: {} }))).toBeNull();
	});

	test("returns null for a structurally-present but empty usage block", () => {
		expect(readUsage(envelopeFor({ type: "turn_end", message: { usage: {} } }))).toBeNull();
		expect(readUsage(envelopeFor({ type: "result", usage: {} }))).toBeNull();
	});

	test("returns null when the usage block is missing entirely", () => {
		expect(readUsage(envelopeFor({ type: "turn_end", message: {} }))).toBeNull();
		expect(readUsage(envelopeFor({ type: "turn_end" }))).toBeNull();
	});

	test("keeps null fields null in a partial reading", () => {
		const reading = readUsage(
			envelopeFor({ type: "turn_end", message: { usage: { cost: { total: 0.5 } } } }),
		);
		expect(reading).toEqual({
			costUsd: 0.5,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
			tokensCacheWrite: null,
		});
	});

	test("accepts a reading on tokens alone (no cost)", () => {
		const reading = readUsage(
			envelopeFor({ type: "turn_end", message: { usage: { input: 3, output: 4 } } }),
		);
		expect(reading?.costUsd).toBeNull();
		expect(reading?.tokensInput).toBe(3);
	});
});

describe("usageShapeFor", () => {
	test("shape.read matches what readUsage returns for that runtime", () => {
		const pi = usageShapeFor("pi" as RuntimeId);
		const claude = usageShapeFor("claude-code" as RuntimeId);
		expect(pi?.read(PI_TURN_END)).toEqual(readUsage(envelopeFor(PI_TURN_END)));
		expect(claude?.read(CLAUDE_RESULT)).toEqual(readUsage(envelopeFor(CLAUDE_RESULT)));
	});

	test("a shape ignores the other runtime's envelope type via readUsage resolution", () => {
		// readUsage gates on envelopeType before calling read, so a pi
		// payload never reaches the claude reader and vice versa.
		expect(readUsage(envelopeFor({ ...PI_TURN_END, type: "result" }))).toBeNull();
		expect(readUsage(envelopeFor({ ...CLAUDE_RESULT, type: "turn_end" }))).toBeNull();
	});
});
