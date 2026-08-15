import { describe, expect, test } from "bun:test";
import {
	CONFIDENCE_BANDS,
	type JudgeVerdict,
	parseVerdict,
	validateVerdict,
	VERDICT_CLASSES,
	VERDICT_NOTE_MAX_CHARS,
	VerdictValidationError,
} from "./wire.ts";

const PROVENANCE = {
	provider: "anthropic",
	model: "claude-haiku-4-5",
	rubricVersion: "sha256:abc123",
	judgedAt: "2026-08-15T16:04:11.000Z",
	costUsd: 0.0031,
} as const;

function validVerdict(): JudgeVerdict {
	return {
		runId: "run_1",
		assignments: [
			{
				class: "spin_loop",
				confidence: "high",
				evidence: [{ fromSeq: 340, toSeq: 612 }],
			},
		],
		provenance: { ...PROVENANCE },
	};
}

describe("VERDICT_CLASSES", () => {
	test("locks the rubric-v1 taxonomy at exactly fifteen classes", () => {
		expect(VERDICT_CLASSES).toHaveLength(15);
		expect(new Set(VERDICT_CLASSES).size).toBe(15);
		expect(VERDICT_CLASSES[0]).toBe("clean");
	});
});

describe("parseVerdict", () => {
	test("accepts a minimal valid verdict", () => {
		expect(parseVerdict(validVerdict())).toEqual(validVerdict());
	});

	test("accepts a clean verdict with no evidence ranges", () => {
		const verdict = parseVerdict({
			runId: "run_1",
			assignments: [{ class: "clean", confidence: "high" }],
			provenance: PROVENANCE,
		});
		expect(verdict.assignments[0]?.evidence).toEqual([]);
	});

	test("accepts multi-label assignments with disjoint evidence ranges", () => {
		const verdict = validVerdict();
		const parsed = parseVerdict({
			...verdict,
			assignments: [
				...verdict.assignments,
				{ class: "env_fumble", confidence: "low", evidence: [{ fromSeq: 1, toSeq: 1 }] },
			],
		});
		expect(parsed.assignments).toHaveLength(2);
	});

	test("rejects clean combined with any other class", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [
					{ class: "clean", confidence: "high" },
					{ class: "spin_loop", confidence: "high", evidence: [{ fromSeq: 1, toSeq: 2 }] },
				],
				provenance: PROVENANCE,
			}),
		).toThrow(VerdictValidationError);
	});

	test("rejects a clean assignment carrying evidence ranges", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [
					{ class: "clean", confidence: "high", evidence: [{ fromSeq: 1, toSeq: 2 }] },
				],
				provenance: PROVENANCE,
			}),
		).toThrow(VerdictValidationError);
	});

	test("rejects a non-clean class without evidence ranges", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [{ class: "hallucinated_state", confidence: "medium", evidence: [] }],
				provenance: PROVENANCE,
			}),
		).toThrow(VerdictValidationError);
	});

	test("rejects a duplicate class assignment", () => {
		const verdict = validVerdict();
		expect(() =>
			parseVerdict({ ...verdict, assignments: [...verdict.assignments, ...verdict.assignments] }),
		).toThrow(/more than once/);
	});

	test("rejects an empty assignments array", () => {
		expect(() =>
			parseVerdict({ runId: "run_1", assignments: [], provenance: PROVENANCE }),
		).toThrow(VerdictValidationError);
	});

	test("rejects an unknown class", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [{ class: "vibes", confidence: "high", evidence: [{ fromSeq: 1, toSeq: 1 }] }],
				provenance: PROVENANCE,
			}),
		).toThrow(/unknown class/);
	});

	test("rejects a float confidence because bands are the only vocabulary", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [{ class: "spin_loop", confidence: 0.87, evidence: [{ fromSeq: 1, toSeq: 1 }] }],
				provenance: PROVENANCE,
			}),
		).toThrow(VerdictValidationError);
		expect(CONFIDENCE_BANDS).toEqual(["low", "medium", "high"]);
	});

	test("rejects a note longer than the 200-character cap", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [
					{
						class: "spin_loop",
						confidence: "high",
						evidence: [{ fromSeq: 1, toSeq: 1 }],
						note: "x".repeat(VERDICT_NOTE_MAX_CHARS + 1),
					},
				],
				provenance: PROVENANCE,
			}),
		).toThrow(/200-character cap/);
	});

	test("accepts a note at exactly the 200-character cap", () => {
		const parsed = parseVerdict({
			runId: "run_1",
			assignments: [
				{
					class: "spin_loop",
					confidence: "high",
					evidence: [{ fromSeq: 1, toSeq: 1 }],
					note: "x".repeat(VERDICT_NOTE_MAX_CHARS),
				},
			],
			provenance: PROVENANCE,
		});
		expect(parsed.assignments[0]?.note).toHaveLength(VERDICT_NOTE_MAX_CHARS);
	});

	test("rejects an inverted evidence range", () => {
		expect(() =>
			parseVerdict({
				runId: "run_1",
				assignments: [
					{ class: "spin_loop", confidence: "high", evidence: [{ fromSeq: 612, toSeq: 340 }] },
				],
				provenance: PROVENANCE,
			}),
		).toThrow(VerdictValidationError);
	});

	test("rejects a missing or incomplete provenance block", () => {
		const verdict = validVerdict();
		expect(() => parseVerdict({ ...verdict, provenance: undefined })).toThrow(/provenance/);
		expect(() =>
			parseVerdict({ ...verdict, provenance: { ...PROVENANCE, costUsd: -1 } }),
		).toThrow(/costUsd/);
		expect(() =>
			parseVerdict({ ...verdict, provenance: { ...PROVENANCE, judgedAt: "not-a-date" } }),
		).toThrow(/judgedAt/);
		expect(() =>
			parseVerdict({ ...verdict, provenance: { ...PROVENANCE, rubricVersion: "" } }),
		).toThrow(/rubricVersion/);
	});

	test("rejects a missing runId", () => {
		const verdict = validVerdict();
		expect(() => parseVerdict({ ...verdict, runId: "" })).toThrow(/runId/);
	});
});

describe("validateVerdict", () => {
	test("round-trips a typed verdict through the same contract", () => {
		expect(validateVerdict(validVerdict())).toEqual(validVerdict());
	});
});
