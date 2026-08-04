import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	test("config file fills the slot below env (warren-fc12: flags > env > file)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-client-test-"));
		try {
			const path = join(dir, "client.json");
			await writeFile(
				path,
				JSON.stringify({ baseUrl: "https://file.example.com", token: "tok-file" }),
			);
			const fromFile = resolveWarrenClient({ WARREN_CLIENT_CONFIG: path });
			expect(fromFile.config.baseUrl).toBe("https://file.example.com");
			expect(fromFile.config.token).toBe("tok-file");
			const envWins = resolveWarrenClient({
				WARREN_CLIENT_CONFIG: path,
				WARREN_BASE_URL: "https://env.example.com",
				WARREN_API_TOKEN: "tok-env",
			});
			expect(envWins.config.baseUrl).toBe("https://env.example.com");
			expect(envWins.config.token).toBe("tok-env");
			const flagWins = resolveWarrenClient(
				{ WARREN_CLIENT_CONFIG: path },
				{ url: "https://flag.example.com" },
			);
			expect(flagWins.config.baseUrl).toBe("https://flag.example.com");
			expect(flagWins.config.token).toBe("tok-file");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a flag-only token still pairs with the default URL", () => {
		const client = resolveWarrenClient({}, { token: "tok-flag" });
		expect(client.config.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(client.config.token).toBe("tok-flag");
	});
});
