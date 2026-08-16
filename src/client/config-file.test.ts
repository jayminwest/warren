import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clientConfigPath,
	loadWarrenClientConfigFromFile,
	saveWarrenClientConfigToFile,
} from "./config-file.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "warren-config-file-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("clientConfigPath", () => {
	test("honors the WARREN_CLIENT_CONFIG override", () => {
		expect(clientConfigPath({ WARREN_CLIENT_CONFIG: "/tmp/x.json" })).toBe("/tmp/x.json");
	});

	test("defaults to ~/.warren/client.json", () => {
		expect(clientConfigPath({})).toEndWith(join(".warren", "client.json"));
	});
});

describe("loadWarrenClientConfigFromFile", () => {
	test("returns undefined when no file exists", () =>
		withTempDir(async (dir) => {
			const env = { WARREN_CLIENT_CONFIG: join(dir, "client.json") };
			expect(loadWarrenClientConfigFromFile(env)).toBeUndefined();
		}));

	test("parses a saved config", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(path, JSON.stringify({ baseUrl: "https://w.example.com", token: "tok" }));
			expect(loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: path })).toEqual({
				baseUrl: "https://w.example.com",
				token: "tok",
			});
		}));

	test("trims surrounding whitespace off a hand-edited token (warren-c550)", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(
				path,
				JSON.stringify({ baseUrl: "https://w.example.com", token: "  tok-padded\n" }),
			);
			expect(loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: path })).toEqual({
				baseUrl: "https://w.example.com",
				token: "tok-padded",
			});
		}));

	test("treats a whitespace-only token as absent", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(path, JSON.stringify({ baseUrl: "https://w.example.com", token: " \n " }));
			expect(loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: path })).toEqual({
				baseUrl: "https://w.example.com",
			});
		}));

	test("rejects an unparseable file with a validation error", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(path, "not json");
			expect(() => loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: path })).toThrow(
				/not valid JSON/,
			);
		}));

	test("rejects a file missing baseUrl", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(path, JSON.stringify({ token: "tok" }));
			expect(() => loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: path })).toThrow(
				/missing a string "baseUrl"/,
			);
		}));
});

describe("saveWarrenClientConfigToFile", () => {
	test("round-trips through the loader with mode 0600", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "nested", "client.json");
			const env = { WARREN_CLIENT_CONFIG: path };
			const written = saveWarrenClientConfigToFile(
				{ baseUrl: "https://w.example.com", token: "tok-secret" },
				env,
			);
			expect(written).toBe(path);
			expect(loadWarrenClientConfigFromFile(env)).toEqual({
				baseUrl: "https://w.example.com",
				token: "tok-secret",
			});
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}));

	test("tightens the mode on a pre-existing world-readable file", () =>
		withTempDir(async (dir) => {
			const path = join(dir, "client.json");
			await writeFile(path, "{}", { mode: 0o644 });
			saveWarrenClientConfigToFile(
				{ baseUrl: "https://w.example.com" },
				{ WARREN_CLIENT_CONFIG: path },
			);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			const body = await readFile(path, "utf8");
			expect(JSON.parse(body)).toEqual({ baseUrl: "https://w.example.com" });
		}));
});
