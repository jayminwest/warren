import { describe, expect, test } from "bun:test";
import { parseBurrowConfig } from "./burrow-config.ts";
import { RunSpawnError } from "./errors.ts";

describe("parseBurrowConfig", () => {
	test("returns an empty config for undefined or blank bodies", () => {
		expect(parseBurrowConfig(undefined)).toEqual({});
		expect(parseBurrowConfig("")).toEqual({});
		expect(parseBurrowConfig("   \n\t\n")).toEqual({});
	});

	test("extracts [sandbox].network", () => {
		const body = `
[toolchain]
bun = "1.1"

[sandbox]
network = "restricted"
allowed_domains = ["api.anthropic.com"]
`;
		expect(parseBurrowConfig(body)).toEqual({ network: "restricted" });
	});

	test("ignores network outside of [sandbox]", () => {
		expect(parseBurrowConfig(`network = "open"\n[other]\nnetwork = "open"`)).toEqual({});
	});

	test("supports single-quoted strings", () => {
		expect(parseBurrowConfig(`[sandbox]\nnetwork = 'open'`)).toEqual({ network: "open" });
	});

	test("strips line comments outside string literals", () => {
		expect(parseBurrowConfig(`[sandbox] # comment\nnetwork = "none" # trailing`)).toEqual({
			network: "none",
		});
	});

	test("rejects an unrecognized network policy with RunSpawnError", () => {
		expect(() => parseBurrowConfig(`[sandbox]\nnetwork = "wide-open"`)).toThrow(RunSpawnError);
	});

	test("rejects an unquoted network value", () => {
		expect(() => parseBurrowConfig(`[sandbox]\nnetwork = restricted`)).toThrow(RunSpawnError);
	});

	test("ignores unrecognized keys inside [sandbox]", () => {
		expect(parseBurrowConfig(`[sandbox]\nallowed_domains = ["x"]`)).toEqual({});
	});
});
