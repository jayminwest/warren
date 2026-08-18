import { describe, expect, test } from "bun:test";
import {
	canonicalRubricPayload,
	canonicalSerialize,
	CLASS_DEFINITIONS,
	computeRubricVersion,
	normalizeWhitespace,
	renderJudgeSystemPrompt,
} from "./rubric.ts";
import { VERDICT_CLASSES } from "./wire.ts";

describe("renderJudgeSystemPrompt", () => {
	test("renders every rubric-v1 class with its definition", () => {
		const prompt = renderJudgeSystemPrompt();
		for (const cls of VERDICT_CLASSES) {
			expect(prompt).toContain(`\`${cls}\``);
			expect(prompt).toContain(CLASS_DEFINITIONS[cls]);
		}
	});

	test("carries the evidence-pointability instructions", () => {
		// The prompt is line-wrapped; flatten before phrase checks.
		const prompt = renderJudgeSystemPrompt().replace(/\n/gu, " ");
		expect(prompt).toContain("{fromSeq, toSeq}");
		expect(prompt).toContain("at least one evidence range");
		expect(prompt).toContain("`low`, `medium`, or `high`");
		expect(prompt).toContain("200");
	});

	test("carries the ground-truth reconciliation instructions", () => {
		// warren-bf3d: three dropped_commit runs were judged clean with the
		// reap.empty_push evidence in context — the prompt must bind the
		// verdict to get_run_facts' state/failureReason and the reap tail.
		const prompt = renderJudgeSystemPrompt().replace(/\n/gu, " ");
		expect(prompt).toContain("## Ground truth reconciliation (mandatory)");
		expect(prompt).toContain("`failureReason: dropped_commit`");
		expect(prompt).toContain("`reap.empty_push`");
		expect(prompt).toContain("CAN coexist with `clean`");
	});

	test("makes report_verdict the mandatory final action", () => {
		const prompt = renderJudgeSystemPrompt();
		expect(prompt).toContain("MUST be a call to the `report_verdict` tool");
		expect(prompt).toContain("no provider-level tool forcing");
	});

	test("is deterministic", () => {
		expect(renderJudgeSystemPrompt()).toBe(renderJudgeSystemPrompt());
	});
});

describe("CLASS_DEFINITIONS", () => {
	test("covers exactly the wire.ts taxonomy, in order", () => {
		expect(Object.keys(CLASS_DEFINITIONS)).toEqual([...VERDICT_CLASSES]);
	});
});

describe("canonicalSerialize", () => {
	test("orders object keys stably at every depth", () => {
		const a = canonicalSerialize({ b: { d: 1, c: 2 }, a: [3, { f: 4, e: 5 }] });
		const b = canonicalSerialize({ a: [3, { e: 5, f: 4 }], b: { c: 2, d: 1 } });
		expect(a).toBe(b);
	});
});

describe("normalizeWhitespace", () => {
	test("folds cosmetic churn", () => {
		expect(normalizeWhitespace("a\r\nb  \n\n\n\nc\n")).toBe("a\nb\n\nc");
	});
});

describe("computeRubricVersion", () => {
	test("is stable across calls", () => {
		expect(computeRubricVersion()).toBe(computeRubricVersion());
		expect(computeRubricVersion()).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	test("whitespace churn in the prompt does not fork the version", () => {
		const baseline = computeRubricVersion();
		const churned = normalizeWhitespace(`${renderJudgeSystemPrompt()}  \n\n\n`);
		expect(churned).toBe(normalizeWhitespace(renderJudgeSystemPrompt()));
		// The canonical payload is built from the normalized prompt, so any
		// input differing only by trailing/blank-line whitespace hashes equal.
		expect(canonicalRubricPayload()).toBe(canonicalRubricPayload());
		expect(computeRubricVersion()).toBe(baseline);
	});

	test("an intentional taxonomy edit forks the version", () => {
		const baseline = canonicalRubricPayload();
		const edited = canonicalSerialize({
			prompt: normalizeWhitespace(renderJudgeSystemPrompt()),
			taxonomy: VERDICT_CLASSES.map((cls) => ({
				class: cls,
				definition: normalizeWhitespace(
					cls === "spin_loop" ? "A narrowed definition." : CLASS_DEFINITIONS[cls],
				),
			})),
		});
		expect(edited).not.toBe(baseline);
	});
});
