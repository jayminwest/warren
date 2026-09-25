/**
 * warren-6016: the agent-child env scrub. The push credential rides the agent
 * CONTAINER env (from the `warren-git-token` Secret) so the finalize/salvage
 * window can authenticate a rescue push, but the blast-radius rule — a
 * compromised agent never holds the push token — still holds for the agent
 * process itself: `defaultSpawn` builds the child's env via `agentChildEnv`.
 */
import { describe, expect, test } from "bun:test";
import { agentChildEnv } from "./agent-io.ts";

describe("agentChildEnv (warren-6016)", () => {
	test("the harness-only push credentials are scrubbed from the inherited env", () => {
		const env = agentChildEnv({
			PATH: "/usr/bin",
			WARREN_GIT_TOKEN: "pod-tok",
			GITHUB_TOKEN: "gh-tok",
			WARREN_RUN_ID: "run_x",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.WARREN_RUN_ID).toBe("run_x");
		expect(env.WARREN_GIT_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
	});

	test("the run-scoped callback token is scrubbed so the agent cannot remint a push credential (warren-ccef)", () => {
		const env = agentChildEnv({
			WARREN_API_TOKEN: "wrs1.run-tok",
			WARREN_API_URL: "http://warren:8080",
			WARREN_AGENT_RUNTIME: "pi",
		});
		expect(env.WARREN_API_TOKEN).toBeUndefined();
		expect(env.WARREN_API_URL).toBe("http://warren:8080");
		expect(env.WARREN_AGENT_RUNTIME).toBe("pi");
	});

	test("a runtime's explicit command.env wins over the scrub (warren-controlled)", () => {
		const env = agentChildEnv(
			{ WARREN_GIT_TOKEN: "pod-tok", PATH: "/usr/bin" },
			{
				WARREN_GIT_TOKEN: "explicit",
			},
		);
		expect(env.WARREN_GIT_TOKEN).toBe("explicit");
	});

	test("undefined inherited values and a missing command env are handled", () => {
		const env = agentChildEnv({ PRESENT: "1", ABSENT: undefined });
		expect(env).toEqual({ PRESENT: "1" });
	});
});
