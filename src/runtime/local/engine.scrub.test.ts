import { describe, expect, test } from "bun:test";
import { scrubSandboxEnv } from "./engine.ts";

describe("scrubSandboxEnv", () => {
	test("drops the run-scoped callback token and URL, keeps everything else", () => {
		expect(
			scrubSandboxEnv({
				WARREN_API_TOKEN: "wrs1.run_x.sig",
				WARREN_API_URL: "http://localhost:8080",
				ANTHROPIC_API_KEY: "sk",
				WARREN_QUALITY_GATE: "bun test",
			}),
		).toEqual({ ANTHROPIC_API_KEY: "sk", WARREN_QUALITY_GATE: "bun test" });
	});
});
