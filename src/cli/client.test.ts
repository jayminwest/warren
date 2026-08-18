import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WARREN_BASE_URL, WarrenClient } from "../client/index.ts";
import {
	resolveClientConfig,
	resolveClientConfigWithSources,
	resolveWarrenClient,
} from "./client.ts";

// Point the config-file slot at a path that cannot exist, so a real
// `~/.warren/client.json` on the dev machine (written by `warren login`)
// never leaks into tests that exercise the built-in default.
const NO_CONFIG_FILE = { WARREN_CLIENT_CONFIG: join(tmpdir(), "warren-client-test-absent.json") };

describe("resolveWarrenClient", () => {
	test("falls back to the built-in default with no env and no flags", () => {
		const client = resolveWarrenClient(NO_CONFIG_FILE);
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

	test("the file token actually rides the wire as the Authorization header (warren-c550)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-client-test-"));
		try {
			const path = join(dir, "client.json");
			await writeFile(
				path,
				JSON.stringify({ baseUrl: "https://file.example.com", token: "tok-file" }),
			);
			const config = resolveClientConfig({ WARREN_CLIENT_CONFIG: path });
			let observedAuth: string | null = null;
			const stubFetch = (async (_url: unknown, init?: RequestInit) => {
				observedAuth = init?.headers ? new Headers(init.headers).get("authorization") : null;
				return Response.json({ identity: "operator", capabilities: [] });
			}) as unknown as typeof fetch;
			const client = new WarrenClient({ config, fetch: stubFetch });
			const who = await client.whoami();
			expect(who.identity).toBe("operator");
			expect(observedAuth as string | null).toBe("Bearer tok-file");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a flag-only token still pairs with the default URL", () => {
		const client = resolveWarrenClient(NO_CONFIG_FILE, { token: "tok-flag" });
		expect(client.config.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(client.config.token).toBe("tok-flag");
	});
});

describe("resolveClientConfigWithSources", () => {
	test("reports the built-in default when no slot supplies a value", () => {
		const resolved = resolveClientConfigWithSources(NO_CONFIG_FILE);
		expect(resolved.config.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(resolved.baseUrlSource).toBe("default");
		expect(resolved.tokenSource).toBeUndefined();
	});

	test("names the winning slot per value, independently (warren-8807)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "warren-client-test-"));
		try {
			const path = join(dir, "client.json");
			await writeFile(
				path,
				JSON.stringify({ baseUrl: "https://file.example.com", token: "tok-file" }),
			);

			const fromFile = resolveClientConfigWithSources({ WARREN_CLIENT_CONFIG: path });
			expect(fromFile.baseUrlSource).toBe("config-file");
			expect(fromFile.tokenSource).toBe("config-file");

			const fromEnv = resolveClientConfigWithSources({
				WARREN_CLIENT_CONFIG: path,
				WARREN_BASE_URL: "https://env.example.com",
				WARREN_API_TOKEN: "tok-env",
			});
			expect(fromEnv.baseUrlSource).toBe("env");
			expect(fromEnv.tokenSource).toBe("env");

			// The url comes from the flag while the token still comes from the
			// env: the two slots are reported apart, which is the whole point.
			const mixed = resolveClientConfigWithSources(
				{ WARREN_CLIENT_CONFIG: path, WARREN_API_TOKEN: "tok-env" },
				{ url: "https://flag.example.com" },
			);
			expect(mixed.baseUrlSource).toBe("flag");
			expect(mixed.tokenSource).toBe("env");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an empty-string flag does not claim the slot it lost", () => {
		const resolved = resolveClientConfigWithSources(
			{ ...NO_CONFIG_FILE, WARREN_API_TOKEN: "tok-env" },
			{ token: "" },
		);
		expect(resolved.config.token).toBe("tok-env");
		expect(resolved.tokenSource).toBe("env");
	});

	test("the merged config matches what resolveClientConfig returns", () => {
		const env = { ...NO_CONFIG_FILE, WARREN_BASE_URL: "https://env.example.com" };
		expect(resolveClientConfigWithSources(env, { token: "tok-flag" }).config).toEqual(
			resolveClientConfig(env, { token: "tok-flag" }),
		);
	});
});
