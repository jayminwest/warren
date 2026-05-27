import { describe, expect, test } from "bun:test";
import { parseArgs } from "./test-pg.ts";

describe("parseArgs", () => {
	test("returns defaults when called with no args", () => {
		const parsed = parseArgs([]);
		expect(parsed.keep).toBe(false);
		expect(parsed.reuse).toBe(false);
		expect(parsed.port).toBe(55432);
		expect(parsed.bunTestArgs).toEqual([]);
	});

	test("collects unknown args as bun-test passthrough", () => {
		const parsed = parseArgs(["src/db/repos/runs.test.ts", "--bail"]);
		expect(parsed.bunTestArgs).toEqual(["src/db/repos/runs.test.ts", "--bail"]);
	});

	test("treats everything after `--` as bun-test args verbatim", () => {
		const parsed = parseArgs(["--keep", "--", "--reuse", "--port=1"]);
		expect(parsed.keep).toBe(true);
		expect(parsed.reuse).toBe(false);
		expect(parsed.port).toBe(55432);
		expect(parsed.bunTestArgs).toEqual(["--reuse", "--port=1"]);
	});

	test("parses --keep / --reuse / --port", () => {
		const parsed = parseArgs(["--keep", "--reuse", "--port=15432"]);
		expect(parsed.keep).toBe(true);
		expect(parsed.reuse).toBe(true);
		expect(parsed.port).toBe(15432);
	});

	test("rejects a malformed --port", () => {
		expect(() => parseArgs(["--port=abc"])).toThrow(/TCP port/);
		expect(() => parseArgs(["--port=0"])).toThrow(/TCP port/);
		expect(() => parseArgs(["--port=70000"])).toThrow(/TCP port/);
	});
});
