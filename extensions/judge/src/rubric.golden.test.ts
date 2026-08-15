import { describe, expect, test } from "bun:test";
import { computeRubricVersion, renderJudgeSystemPrompt } from "./rubric.ts";

/**
 * Golden pins for rubric v1: the rendered judge system prompt and the
 * rubricVersion hash for the canonical input. An intentional edit to the
 * prompt or taxonomy must regenerate these fixtures — the regenerated hash
 * IS the new rubric version. Regenerate with:
 *   JUDGE_UPDATE_GOLDENS=1 bun test src/rubric.golden.test.ts
 */
const PROMPT_FIXTURE = "rubric.system-prompt.txt";
const VERSION_FIXTURE = "rubric.version.json";

function fixtureUrl(name: string): URL {
	return new URL(`__golden__/${name}`, import.meta.url);
}

describe("rubric golden fixtures", () => {
	test("pins the rendered judge system prompt", async () => {
		const rendered = `${renderJudgeSystemPrompt()}\n`;
		if (process.env.JUDGE_UPDATE_GOLDENS === "1") {
			await Bun.write(fixtureUrl(PROMPT_FIXTURE), rendered);
		}
		expect(await Bun.file(fixtureUrl(PROMPT_FIXTURE)).text()).toBe(rendered);
	});

	test("pins the rubricVersion hash for the canonical input", async () => {
		const version = computeRubricVersion();
		if (process.env.JUDGE_UPDATE_GOLDENS === "1") {
			await Bun.write(
				fixtureUrl(VERSION_FIXTURE),
				`${JSON.stringify({ rubricVersion: version }, null, "\t")}\n`,
			);
		}
		const pinned = JSON.parse(await Bun.file(fixtureUrl(VERSION_FIXTURE)).text()) as {
			rubricVersion: string;
		};
		expect(version).toBe(pinned.rubricVersion);
	});
});
