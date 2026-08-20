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

	test("blames the environment and warns about an auto-loaded .env", () => {
		const hint = authFailureHint("env", {});
		expect(hint).toContain("came from WARREN_API_TOKEN in the environment");
		expect(hint).toContain(".env");
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

	test("names every slot when no source was resolved", () => {
		const hint = authFailureHint(undefined, CONFIG_AT);
		expect(hint).toContain("WARREN_API_TOKEN");
		expect(hint).toContain("--token");
		expect(hint).toContain("warren login");
	});
});
