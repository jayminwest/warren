/**
 * Bot-grammar validation tests (plan pl-096b step warren-2ec3).
 *
 * Recognition rules are operator profile data, validated fail-closed:
 * unknown keys, invalid logins, non-compiling patterns, and capture groups
 * outside the known structured extraction set are all refused.
 */

import { describe, expect, test } from "bun:test";
import { validateBotGrammar } from "./bot-grammar.ts";

const VALID = {
	knownBotLogins: ["lintbot"],
	findingMarker: "### Findings",
	findingLinePattern: "^-\\s*(?<title>[^:]+):(?<file>[^:]+):(?<line>\\d+)$",
	reReviewCommands: ["/bot re-review"],
};

describe("validateBotGrammar", () => {
	test("accepts and round-trips a valid grammar", () => {
		const grammar = validateBotGrammar(VALID);
		expect(grammar.knownBotLogins).toEqual(["lintbot"]);
		expect(grammar.reReviewCommands).toEqual(["/bot re-review"]);
	});

	test("rejects unknown keys fail-closed", () => {
		expect(() => validateBotGrammar({ ...VALID, marker: "evil" })).toThrow(/unknown field/);
	});

	test("rejects invalid bot logins", () => {
		expect(() => validateBotGrammar({ ...VALID, knownBotLogins: ["-bad-"] })).toThrow(
			/invalid bot login/,
		);
	});

	test("rejects a pattern that does not compile", () => {
		expect(() => validateBotGrammar({ ...VALID, findingLinePattern: "(?<title" })).toThrow(
			/invalid regex/,
		);
	});

	test("rejects a pattern without a title group", () => {
		expect(() => validateBotGrammar({ ...VALID, findingLinePattern: "^- (.+)$" })).toThrow(
			/missing required capture group/,
		);
	});

	test("rejects capture groups outside the structured extraction set", () => {
		expect(() =>
			validateBotGrammar({ ...VALID, findingLinePattern: "^(?<title>.+) (?<command>.+)$" }),
		).toThrow(/unknown capture group/);
	});

	test("rejects oversized markers and patterns", () => {
		expect(() => validateBotGrammar({ ...VALID, findingMarker: "m".repeat(129) })).toThrow(
			/at most/,
		);
		expect(() => validateBotGrammar({ ...VALID, findingLinePattern: "x".repeat(257) })).toThrow(
			/at most/,
		);
	});
});
