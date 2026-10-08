import { describe, expect, test } from "bun:test";

import { parseRunArgs } from "./run.ts";

describe("parseRunArgs", () => {
	test("forwards everything except --build and --port to playwright", () => {
		expect(parseRunArgs(["--build", "--grep", "runs", "--port", "4517", "--headed"])).toEqual({
			build: true,
			port: 4517,
			playwrightArgs: ["--grep", "runs", "--headed"],
		});
	});

	test("defaults to no build and a picked port", () => {
		expect(parseRunArgs([])).toEqual({ build: false, port: undefined, playwrightArgs: [] });
	});

	test("rejects a bad --port", () => {
		expect(() => parseRunArgs(["--port", "nope"])).toThrow("--port needs an integer");
		expect(() => parseRunArgs(["--port"])).toThrow("got ''");
	});
});
