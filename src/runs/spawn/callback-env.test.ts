import { describe, expect, test } from "bun:test";
import { injectWarrenCallbackEnv, loopbackApiUrl } from "./callback-env.ts";

describe("injectWarrenCallbackEnv", () => {
	test("injects token + loopback URL when the server has a token", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, { WARREN_API_TOKEN: "tok_secret", WARREN_BIND_PORT: "9090" });
		expect(env.WARREN_API_TOKEN).toBe("tok_secret");
		expect(env.WARREN_API_URL).toBe("http://localhost:9090");
	});

	test("defaults the callback URL to port 8080 when WARREN_BIND_PORT is unset", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, { WARREN_API_TOKEN: "tok_secret" });
		expect(env.WARREN_API_URL).toBe("http://localhost:8080");
	});

	test("injects nothing when the server runs --no-auth (no token)", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, {});
		expect(env.WARREN_API_TOKEN).toBeUndefined();
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("treats an empty-string token as no token", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, { WARREN_API_TOKEN: "" });
		expect(env.WARREN_API_TOKEN).toBeUndefined();
		expect(env.WARREN_API_URL).toBeUndefined();
	});

	test("injects the token but omits the URL on a unix-socket-only bind", () => {
		const env: Record<string, string> = {};
		injectWarrenCallbackEnv(env, {
			WARREN_API_TOKEN: "tok_secret",
			WARREN_BIND_SOCKET: "/run/warren.sock",
		});
		expect(env.WARREN_API_TOKEN).toBe("tok_secret");
		expect(env.WARREN_API_URL).toBeUndefined();
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
