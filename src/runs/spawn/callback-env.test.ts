import { describe, expect, test } from "bun:test";
import { injectWarrenCallbackEnv, loopbackApiUrl } from "./callback-env.ts";
import { isRunScopedToken, verifyRunScopedToken } from "./run-token.ts";

const RUN_ID = "run_abc123def456";

describe("injectWarrenCallbackEnv", () => {
	test("injects a run-scoped token (not the operator token) + loopback URL", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(
			env,
			{ WARREN_API_TOKEN: "tok_secret", WARREN_BIND_PORT: "9090" },
			RUN_ID,
		);
		// The injected credential is NOT the operator token — that is the whole fix.
		expect(env.WARREN_API_TOKEN).not.toBe("tok_secret");
		expect(isRunScopedToken(env.WARREN_API_TOKEN ?? "")).toBe(true);
		// It verifies against the operator token as the signing secret, bound to this run.
		expect(verifyRunScopedToken(env.WARREN_API_TOKEN ?? "", "tok_secret")).toBe(RUN_ID);
		expect(env.WARREN_API_URL).toBe("http://localhost:9090");
	});

	test("defaults the callback URL to port 8080 when WARREN_BIND_PORT is unset", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, { WARREN_API_TOKEN: "tok_secret" }, RUN_ID);
		expect(env.WARREN_API_URL).toBe("http://localhost:8080");
	});

	test("injects nothing when the server runs --no-auth (no token)", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, {}, RUN_ID);
		expect(env.WARREN_API_TOKEN).toBeUndefined();
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("treats an empty-string token as no token", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, { WARREN_API_TOKEN: "" }, RUN_ID);
		expect(env.WARREN_API_TOKEN).toBeUndefined();
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("injects the token but omits the URL on a unix-socket-only bind", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(
			env,
			{ WARREN_API_TOKEN: "tok_secret", WARREN_BIND_SOCKET: "/run/warren.sock" },
			RUN_ID,
		);
		expect(isRunScopedToken(env.WARREN_API_TOKEN ?? "")).toBe(true);
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("binds the token to the specific run id", () => {
		const a: Record<string, string> = {};
		const b: Record<string, string> = {};
		injectWarrenCallbackEnv(a, { WARREN_API_TOKEN: "tok_secret" }, "run_aaaaaaaaaaaa");
		injectWarrenCallbackEnv(b, { WARREN_API_TOKEN: "tok_secret" }, "run_bbbbbbbbbbbb");
		expect(a.WARREN_API_TOKEN).not.toBe(b.WARREN_API_TOKEN);
		expect(verifyRunScopedToken(a.WARREN_API_TOKEN ?? "", "tok_secret")).toBe("run_aaaaaaaaaaaa");
	});
});

describe("loopbackApiUrl", () => {
	test("returns localhost on the configured TCP port", () => {
		expect(loopbackApiUrl({ WARREN_BIND_PORT: "9090" })).toBe("http://localhost:9090");
	});

	test("defaults to port 8080 when WARREN_BIND_PORT is empty or unset", () => {
		expect(loopbackApiUrl({})).toBe("http://localhost:8080");
		expect(loopbackApiUrl({ WARREN_BIND_PORT: "" })).toBe("http://localhost:8080");
	});

	test("returns null when bound to a unix socket only", () => {
		expect(loopbackApiUrl({ WARREN_BIND_SOCKET: "/run/warren.sock" })).toBeNull();
	});

	test("ignores the bind host so a 0.0.0.0 bind still yields a dialable loopback", () => {
		expect(loopbackApiUrl({ WARREN_BIND_HOST: "0.0.0.0", WARREN_BIND_PORT: "8080" })).toBe(
			"http://localhost:8080",
		);
	});
});
