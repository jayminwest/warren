import { describe, expect, test } from "bun:test";
import {
	buildFixerPrompt,
	type CiFixerSettings,
	type DecideDispatchInput,
	decideDispatch,
} from "./dispatch.ts";

const SETTINGS: CiFixerSettings = { enabled: true, maxRetries: 2, cooldownMinutes: 10 };
const NOW = new Date("2026-05-29T12:00:00.000Z");

function input(over: Partial<DecideDispatchInput>): DecideDispatchInput {
	return {
		settings: SETTINGS,
		verdict: "failing",
		history: { attempts: 0, lastAttemptAt: null },
		now: NOW,
		...over,
	};
}

describe("decideDispatch", () => {
	test("dispatches when failing, enabled, under retries, no cooldown", () => {
		expect(decideDispatch(input({})).kind).toBe("dispatch");
	});

	test("skips with disabled when the project hasn't opted in", () => {
		const decision = decideDispatch(input({ settings: { ...SETTINGS, enabled: false } }));
		expect(decision).toEqual({ kind: "skip", reason: "disabled" });
	});

	test("skips with not_failing for pending / passing / no_checks verdicts", () => {
		for (const verdict of ["pending", "passing", "no_checks"] as const) {
			expect(decideDispatch(input({ verdict }))).toEqual({
				kind: "skip",
				reason: "not_failing",
			});
		}
	});

	test("skips with max_retries when attempts reach the cap", () => {
		expect(decideDispatch(input({ history: { attempts: 2, lastAttemptAt: null } }))).toEqual({
			kind: "skip",
			reason: "max_retries",
		});
	});

	test("skips with cooldown when last attempt is within the window", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
		expect(decideDispatch(input({ history: { attempts: 1, lastAttemptAt } }))).toEqual({
			kind: "skip",
			reason: "cooldown",
		});
	});

	test("dispatches when the cooldown window has elapsed", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 15 * 60_000).toISOString();
		expect(decideDispatch(input({ history: { attempts: 1, lastAttemptAt } })).kind).toBe(
			"dispatch",
		);
	});

	test("zero cooldown disables the gate", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 1_000).toISOString();
		const settings = { ...SETTINGS, cooldownMinutes: 0 };
		expect(decideDispatch(input({ settings, history: { attempts: 1, lastAttemptAt } })).kind).toBe(
			"dispatch",
		);
	});

	test("max_retries takes precedence over cooldown", () => {
		const lastAttemptAt = new Date(NOW.getTime() - 1_000).toISOString();
		expect(decideDispatch(input({ history: { attempts: 2, lastAttemptAt } }))).toEqual({
			kind: "skip",
			reason: "max_retries",
		});
	});

	test("a corrupt lastAttemptAt is treated as no prior attempt (never strands)", () => {
		expect(
			decideDispatch(input({ history: { attempts: 1, lastAttemptAt: "not-a-date" } })).kind,
		).toBe("dispatch");
	});
});

describe("buildFixerPrompt", () => {
	test("includes the PR url, failing checks, and a fenced log tail", () => {
		const prompt = buildFixerPrompt({
			prUrl: "https://github.com/o/r/pull/3",
			failures: [{ name: "test", conclusion: "failure", detailsUrl: "https://ci/1" }],
			logTail: "FAIL src/foo.test.ts\nExpected 1 got 2",
		});
		expect(prompt).toContain("https://github.com/o/r/pull/3");
		expect(prompt).toContain("- test: failure (https://ci/1)");
		expect(prompt).toContain("```");
		expect(prompt).toContain("FAIL src/foo.test.ts");
		expect(prompt).toContain("Do not open a new PR");
	});

	test("falls back to a diagnose-from-codebase note when no log tail is available", () => {
		const prompt = buildFixerPrompt({
			prUrl: "https://github.com/o/r/pull/3",
			failures: [{ name: "third-party", conclusion: "failure", detailsUrl: null }],
			logTail: null,
		});
		expect(prompt).toContain("No CI log could be fetched");
		expect(prompt).not.toContain("```");
	});
});
