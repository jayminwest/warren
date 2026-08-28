import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { authFailureHint } from "./auth-hints.ts";

const CONFIG_AT = { WARREN_CLIENT_CONFIG: join("/srv", "agent", "client.json") };

describe("authFailureHint", () => {
	test("blames the flag when the flag supplied the token", () => {
		const hint = authFailureHint("flag", {});
		expect(hint).toContain("came from --token");
		expect(hint).not.toContain("WARREN_API_TOKEN");
	});

	test("blames the environment and notes a cwd .env is never auto-loaded", () => {
		const hint = authFailureHint("env", {});
		expect(hint).toContain("came from WARREN_API_TOKEN in the environment");
		expect(hint).toContain(".env");
	});

	test("tells the env arm to check the token, the way the flag arm does", () => {
		// warren-4f1b: the env arm told only the stale-`.env` story and dropped
		// the advice the flag arm still carried.
		for (const source of ["flag", "env"] as const) {
			expect(authFailureHint(source, {}), source).toContain(
				"check it against the server's credential",
			);
		}
	});

	test("blames the config file and points back at warren login", () => {
		const hint = authFailureHint("config-file", CONFIG_AT);
		expect(hint).toContain("came from the client config file");
		expect(hint).toContain("warren login");
	});

	test("names the resolved config path, not a hard-coded ~/.warren/client.json", () => {
		expect(authFailureHint("config-file", CONFIG_AT)).toContain(CONFIG_AT.WARREN_CLIENT_CONFIG);
		expect(authFailureHint("env", CONFIG_AT)).toContain(CONFIG_AT.WARREN_CLIENT_CONFIG);
		expect(authFailureHint(undefined, CONFIG_AT)).toContain(CONFIG_AT.WARREN_CLIENT_CONFIG);
	});

	test("reads an absent source as no token at all, not as a search to run", () => {
		// warren-4f1b: absent means every slot is empty, which is an ordinary
		// production state. Sending the operator to check three empty slots
		// described a search they had already lost.
		const hint = authFailureHint(undefined, CONFIG_AT);
		expect(hint).toContain("no token is configured");
		expect(hint).toContain("are all empty");
		expect(hint).toContain("warren login");
		expect(hint).toContain("WARREN_API_TOKEN");
		expect(hint).toContain("--token");
	});
});
