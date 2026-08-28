import { describe, expect, test } from "bun:test";
import {
	ADVISORY_RULES,
	countable,
	lint,
	proseLines,
	splitSentences,
	wordCount,
} from "./check-prose.ts";

function rules(markdown: string): string[] {
	return lint(markdown, 25).violations.map((v) => v.rule);
}

function countOf(markdown: string, rule: string): number {
	return rules(markdown).filter((r) => r === rule).length;
}

describe("proseLines", () => {
	test("drops fenced code blocks", () => {
		const md = "Real prose here.\n\n```ts\nconst x = 1; // don't\n```\n\nMore prose.";
		const texts = proseLines(md).map((l) => l.text);
		expect(texts).toEqual(["Real prose here.", "More prose."]);
	});

	test("drops frontmatter, headings, tables, and html", () => {
		const md =
			"---\ntitle: x; y\n---\n\n# Heading; here\n\n| a | b; c |\n\n<!-- comment; -->\n\nProse.";
		expect(proseLines(md).map((l) => l.text)).toEqual(["Prose."]);
	});

	test("keeps link text but drops the target", () => {
		const [first] = proseLines("See [the runbook](https://example.com/a;b) for detail.");
		expect(first?.text).toBe("See the runbook for detail.");
	});

	test("replaces inline code with a placeholder", () => {
		const [first] = proseLines("Run `bun test; echo hi` now.");
		expect(first?.text).toBe("Run CODE now.");
	});

	test("marks list items", () => {
		const lines = proseLines("Intro line.\n- A bullet.\n1. A number.");
		expect(lines.map((l) => l.isList)).toEqual([false, true, true]);
	});

	test("reports 1-based source line numbers", () => {
		const lines = proseLines("# H\n\nFirst.\n\nSecond.");
		expect(lines.map((l) => l.line)).toEqual([3, 5]);
	});
});

describe("splitSentences and wordCount", () => {
	test("splits on terminal punctuation followed by a capital", () => {
		expect(splitSentences("One thing. Two things. Three.")).toHaveLength(3);
	});

	test("does not split on a lowercase continuation after a colon", () => {
		expect(splitSentences("The steps are: connect, then dispatch.")).toHaveLength(1);
	});

	test("counts hyphenated and slashed tokens as one word", () => {
		expect(wordCount("Use the built-in claude-code agent.")).toBe(5);
	});
});

describe("contractions vs possessives", () => {
	test("flags real contractions", () => {
		expect(countOf("Do not worry, it isn't ready and we're late.", "contraction")).toBe(2);
	});

	test("does not flag possessives (STE GR-8 permits them)", () => {
		expect(countOf("Warren's supervisor spawns burrow's daemon.", "contraction")).toBe(0);
	});

	test("flags it's but not its", () => {
		expect(countOf("It's here. Its owner left.", "contraction")).toBe(1);
	});
});

describe("passive voice", () => {
	test("flags agentive passive", () => {
		expect(countOf("The circuits are connected by a switching relay.", "passive-voice")).toBe(1);
	});

	test("does not flag past participle as adjective (STE Rule 3.3)", () => {
		expect(countOf("The unit is fully disassembled.", "passive-voice")).toBe(0);
		expect(countOf("Make sure that the run is completed.", "passive-voice")).toBe(0);
	});

	test("flags an adjectival participle when an agent follows", () => {
		expect(countOf("The run is completed by the reaper.", "passive-voice")).toBe(1);
	});
});

describe("-ing main verbs", () => {
	test("flags a progressive main verb", () => {
		expect(countOf("The supervisor is starting the daemon.", "ing-main-verb")).toBe(1);
	});

	test("does not flag -ing words that are nouns or adjectives", () => {
		expect(countOf("There is nothing here. The file is missing.", "ing-main-verb")).toBe(0);
	});
});

describe("noun stacks", () => {
	test("flags a determiner-anchored stack over three words", () => {
		expect(countOf("Inspect the per-request pino child logger.", "noun-stack(>3)")).toBe(1);
	});

	test("does not flag a three-word stack", () => {
		expect(countOf("Inspect the pino child logger.", "noun-stack(>3)")).toBe(0);
	});

	test("does not run a stack across punctuation", () => {
		expect(countOf("The scheduler: connect, add, spawn, watch.", "noun-stack(>3)")).toBe(0);
	});

	test("requires a determiner anchor", () => {
		expect(countOf("Warren ships built-in claude-code sandbox agents.", "noun-stack(>3)")).toBe(0);
	});

	test("is advisory, not counted toward the budget", () => {
		expect(ADVISORY_RULES.has("noun-stack(>3)")).toBe(true);
		const violations = lint("Inspect the per-request pino child logger.", 25).violations;
		expect(violations).toHaveLength(1);
		expect(countable(violations)).toHaveLength(0);
	});
});

describe("paragraphs", () => {
	test("flags a paragraph over six sentences", () => {
		const md = "A one. B two. C three. D four. E five. F six. G seven.";
		expect(countOf(md, "long-paragraph(>6s)")).toBe(1);
	});

	test("does not flag a six-sentence paragraph", () => {
		expect(countOf("A one. B two. C three. D four. E five. F six.", "long-paragraph(>6s)")).toBe(0);
	});

	test("does not count vertical list items (STE Rule 4.3 wants lists)", () => {
		const md = [
			"- A one.",
			"- B two.",
			"- C three.",
			"- D four.",
			"- E five.",
			"- F six.",
			"- G seven.",
		].join("\n");
		expect(countOf(md, "long-paragraph(>6s)")).toBe(0);
	});
});

describe("other mechanical rules", () => {
	test("flags semicolons", () => {
		expect(countOf("Start the run; then watch it.", "semicolon")).toBe(1);
	});

	test("flags sentences over the cap", () => {
		const long = `The ${"word ".repeat(30)}ends here.`;
		expect(lint(long, 25).violations.some((v) => v.rule.startsWith("long-sentence"))).toBe(true);
	});

	test("respects the configured cap", () => {
		const md = "One two three four five six seven eight nine ten eleven twelve.";
		expect(lint(md, 25).violations.some((v) => v.rule.startsWith("long-sentence"))).toBe(false);
		expect(lint(md, 10).violations.some((v) => v.rule.startsWith("long-sentence"))).toBe(true);
	});

	test("flags Latin abbreviations", () => {
		expect(countOf("Use a tool, e.g. burrow, for this.", "latin-abbreviation")).toBe(1);
	});

	test("flags phrasal verbs", () => {
		expect(countOf("Spin up the sandbox.", "phrasal-verb")).toBe(1);
	});

	test("flags substitution-list words", () => {
		expect(countOf("Ensure the daemon can utilize the socket.", "substitute-word")).toBe(2);
	});

	test("flags marketing adjectives", () => {
		expect(countOf("A seamless and robust control plane.", "marketing-adjective")).toBe(2);
	});

	test("flags an em dash", () => {
		expect(countOf("The run finished — the branch is pushed.", "dash")).toBe(1);
	});

	test("flags a spaced en dash and a spaced double hyphen", () => {
		expect(countOf("The run finished – the branch is pushed.", "dash")).toBe(1);
		expect(countOf("The run finished -- the branch is pushed.", "dash")).toBe(1);
	});

	test("does not flag hyphenated compounds, ranges, or CLI flags", () => {
		expect(countOf("Use kebab-case names for steps 1–5 with the --json flag.", "dash")).toBe(0);
	});

	test("does not flag a dash inside inline code", () => {
		expect(countOf("Run `warren run -- --json` to pass args through.", "dash")).toBe(0);
	});

	test("flags nominalizations", () => {
		expect(countOf("Perform an analysis of the log.", "nominalization")).toBe(1);
	});

	test("ignores everything inside code fences", () => {
		const md = "```\nEnsure it isn't seamless; e.g. spin up.\n```";
		expect(lint(md, 25).violations).toHaveLength(0);
	});

	test("counts words only from prose", () => {
		expect(lint("Two words.\n\n```\nignored code here\n```", 25).words).toBe(2);
	});
});
