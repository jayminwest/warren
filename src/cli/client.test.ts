import { describe, expect, test } from "bun:test";
import { DEFAULT_WARREN_BASE_URL } from "../client/index.ts";
import { resolveWarrenClient } from "./client.ts";

describe("resolveWarrenClient", () => {
	test("falls back to the built-in default with no env and no flags", () => {
		const client = resolveWarrenClient({});
		expect(client.config.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(client.config.token).toBeUndefined();
	});

	test("reads WARREN_BASE_URL + WARREN_API_TOKEN from the env", () => {
		const client = resolveWarrenClient({
			WARREN_BASE_URL: "https://warren.example.com",
			WARREN_API_TOKEN: "tok-env",
		});
		expect(client.config.baseUrl).toBe("https://warren.example.com");
		expect(client.config.token).toBe("tok-env");
	});

	test("flags beat env (precedence: flags > env, warren-97a2 D5)", () => {
		const client = resolveWarrenClient(
			{ WARREN_BASE_URL: "https://env.example.com", WARREN_API_TOKEN: "tok-env" },
			{ url: "https://flag.example.com", token: "tok-flag" },
		);
		expect(client.config.baseUrl).toBe("https://flag.example.com");
		expect(client.config.token).toBe("tok-flag");
	});

	test("empty-string flags are treated as unset", () => {
		const client = resolveWarrenClient(
			{ WARREN_BASE_URL: "https://env.example.com", WARREN_API_TOKEN: "tok-env" },
			{ url: "", token: "" },
		);
		expect(client.config.baseUrl).toBe("https://env.example.com");
		expect(client.config.token).toBe("tok-env");
	});

	test("a flag-only token still pairs with the default URL", () => {
		const client = resolveWarrenClient({}, { token: "tok-flag" });
		expect(client.config.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(client.config.token).toBe("tok-flag");
	});
});
