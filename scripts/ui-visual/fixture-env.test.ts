import { describe, expect, test } from "bun:test";

import { FIXTURE_ENV, parseFixtureEnv } from "./fixture-env.ts";

const OUTPUT = {
	baseUrl: "http://127.0.0.1:4517",
	token: "warren-ui-visual-fixture-token",
	frozenNow: "2026-09-15T12:00:00.000Z",
	frozenNowMs: 1789473600000,
	uiServed: true,
	tmpRoot: "/tmp/warren-ui-visual-x",
	ids: { runs: {} },
};

describe("parseFixtureEnv", () => {
	test("parses the fixture boot's JSON output line", () => {
		expect(parseFixtureEnv(JSON.stringify(OUTPUT)).baseUrl).toBe("http://127.0.0.1:4517");
	});

	test("explains how to provide the fixture when the env var is unset", () => {
		expect(() => parseFixtureEnv(undefined)).toThrow(`${FIXTURE_ENV} is not set`);
		expect(() => parseFixtureEnv("  ")).toThrow("bun run check:ui-visual");
	});

	test("rejects malformed JSON and a non-object", () => {
		expect(() => parseFixtureEnv("{nope")).toThrow("is not JSON");
		expect(() => parseFixtureEnv("[]")).toThrow("is missing");
		expect(() => parseFixtureEnv("null")).toThrow("must be a JSON object");
	});

	test("names every missing or mistyped field", () => {
		const { token: _t, frozenNowMs: _f, ...rest } = OUTPUT;
		expect(() => parseFixtureEnv(JSON.stringify({ ...rest, ids: null }))).toThrow(
			"is missing token (string), frozenNowMs (number), ids (object)",
		);
	});

	test("refuses a boot that is not serving the SPA", () => {
		expect(() => parseFixtureEnv(JSON.stringify({ ...OUTPUT, uiServed: false }))).toThrow(
			"bun run build:ui",
		);
	});
});
