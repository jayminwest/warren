/**
 * Unit tests for `extractSuggestedIntent` (warren-d22e / pl-0344 step 8).
 *
 * Pins the marker-format contract the brainstorm agent's system prompt
 * advertises: `**goal**: ...` / `**non_goals**:` / `**constraints**:` /
 * `**success_criteria**:` blocks. The parser is case-insensitive,
 * tolerates bold + heading + dash separators, accumulates list fields
 * deduplicated across messages, and overwrites the singular `goal`
 * field with the most recent claim.
 */

import { describe, expect, test } from "bun:test";
import type { EventRow } from "../db/schema.ts";
import { extractSuggestedIntent } from "./formalize.ts";

function ev(ts: string, content: string, overrides: Partial<EventRow> = {}): EventRow {
	return {
		id: 1,
		runId: "run_x",
		burrowEventSeq: 1,
		ts,
		kind: "agent_message",
		stream: "system",
		payloadJson: { actor: "agent:brainstorm:run_x", content },
		...overrides,
	} as EventRow;
}

describe("extractSuggestedIntent", () => {
	test("returns empty intent when no events", () => {
		expect(extractSuggestedIntent([])).toEqual({
			goal: "",
			non_goals: [],
			constraints: [],
			success_criteria: [],
		});
	});

	test("parses a single complete agent message with all four fields", () => {
		const out = extractSuggestedIntent([
			ev(
				"2026-05-23T00:00:00Z",
				[
					"Here's what I'm hearing:",
					"",
					"**goal**: ship a self-hostable warren tutorial",
					"",
					"**non_goals**:",
					"- supporting Windows host",
					"- multi-tenant deploys",
					"",
					"**constraints**:",
					"- must boot from a single docker compose",
					"",
					"**success_criteria**:",
					"- new user dispatches a run within 10 minutes",
					"- README cited in 3 community posts",
				].join("\n"),
			),
		]);
		expect(out.goal).toBe("ship a self-hostable warren tutorial");
		expect(out.non_goals).toEqual(["supporting Windows host", "multi-tenant deploys"]);
		expect(out.constraints).toEqual(["must boot from a single docker compose"]);
		expect(out.success_criteria).toEqual([
			"new user dispatches a run within 10 minutes",
			"README cited in 3 community posts",
		]);
	});

	test("later goal overrides earlier; list fields accumulate deduplicated", () => {
		const out = extractSuggestedIntent([
			ev("2026-05-23T00:00:00Z", "**goal**: first draft\n**non_goals**:\n- A\n- B"),
			ev("2026-05-23T00:01:00Z", "**goal**: refined draft\n**non_goals**:\n- B\n- C"),
		]);
		expect(out.goal).toBe("refined draft");
		expect(out.non_goals).toEqual(["A", "B", "C"]);
	});

	test("case-insensitive markers + heading syntax + dash separators", () => {
		const out = extractSuggestedIntent([
			ev(
				"2026-05-23T00:00:00Z",
				[
					"### Goal",
					"ship it",
					"",
					"## Non-Goals",
					"- nope",
					"",
					"# Constraints",
					"- bounded budget",
					"",
					"Success Criteria —",
					"- it merges",
				].join("\n"),
			),
		]);
		expect(out.goal).toBe("ship it");
		expect(out.non_goals).toEqual(["nope"]);
		expect(out.constraints).toEqual(["bounded budget"]);
		expect(out.success_criteria).toEqual(["it merges"]);
	});

	test("non-agent_message-shaped payloads are tolerated (null payload, missing content)", () => {
		const out = extractSuggestedIntent([
			ev("2026-05-23T00:00:00Z", "", { payloadJson: null }),
			ev("2026-05-23T00:01:00Z", "", { payloadJson: { actor: "x" } }),
			ev("2026-05-23T00:02:00Z", "**goal**: only this one counts"),
		]);
		expect(out.goal).toBe("only this one counts");
	});

	test("sorts by ts asc then by burrowEventSeq", () => {
		const out = extractSuggestedIntent([
			ev("2026-05-23T00:01:00Z", "**goal**: second", { burrowEventSeq: 2 }),
			ev("2026-05-23T00:00:00Z", "**goal**: first", { burrowEventSeq: 1 }),
			ev("2026-05-23T00:01:00Z", "**goal**: third", { burrowEventSeq: 3 }),
		]);
		expect(out.goal).toBe("third");
	});

	test("list-field bullets accept * and numbered styles", () => {
		const out = extractSuggestedIntent([
			ev(
				"2026-05-23T00:00:00Z",
				["**non_goals**:", "* one", "* two", "", "**constraints**:", "1. alpha", "2. beta"].join(
					"\n",
				),
			),
		]);
		expect(out.non_goals).toEqual(["one", "two"]);
		expect(out.constraints).toEqual(["alpha", "beta"]);
	});

	test("empty message body yields empty intent", () => {
		const out = extractSuggestedIntent([
			ev("2026-05-23T00:00:00Z", "just some chit-chat, no markers"),
		]);
		expect(out).toEqual({ goal: "", non_goals: [], constraints: [], success_criteria: [] });
	});
});
