import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWarrenClientConfigFromFile } from "../../client/config-file.ts";
import {
	WarrenClient,
	type WarrenClientConfig,
	WarrenClientError,
	type WhoamiResponse,
} from "../../client/index.ts";
import { resolveClientConfig } from "../client.ts";
import type { CliContext } from "../output.ts";
import { runLogin } from "./login.ts";

function captureContext(env: Record<string, string | undefined> = {}): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env,
			stdio: {
				stdout: { write: (c) => out.push(c) },
				stderr: { write: (c) => err.push(c) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		out,
		err,
	};
}

const RESOLVE = (a: { url?: string }): WarrenClientConfig => ({
	baseUrl: a.url ?? "http://localhost:8080",
});

function okClient(recorded: { config?: WarrenClientConfig }) {
	return (config: WarrenClientConfig) => {
		recorded.config = config;
		return {
			whoami: async (): Promise<WhoamiResponse> => ({
				identity: "operator",
				capabilities: ["dispatch"],
			}),
		};
	};
}

async function withTempConfig(fn: (env: Record<string, string>, dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "warren-login-test-"));
	try {
		await fn({ WARREN_CLIENT_CONFIG: join(dir, "client.json") }, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("runLogin", () => {
	test("verifies via whoami and persists base URL + token (0600)", () =>
		withTempConfig(async (env) => {
			const recorded: { config?: WarrenClientConfig } = {};
			const { context, out } = captureContext(env);
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient(recorded),
					readTokenFromStdin: async () => "",
				},
				{ url: "https://w.example.com", token: "tok-secret-123" },
			);
			expect(result.exitCode).toBe(0);
			expect(recorded.config).toEqual({
				baseUrl: "https://w.example.com",
				token: "tok-secret-123",
			});
			const saved = loadWarrenClientConfigFromFile(env);
			expect(saved).toEqual({ baseUrl: "https://w.example.com", token: "tok-secret-123" });
			expect(statSync(env.WARREN_CLIENT_CONFIG ?? "").mode & 0o777).toBe(0o600);
			// Token never round-trips into stdout.
			expect(out.join("")).not.toContain("tok-secret-123");
			expect(out.join("")).toContain('"identity":"operator"');
		}));

	test("reads the token from stdin when not flagged or env'd", () =>
		withTempConfig(async (env) => {
			const { context } = captureContext(env);
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient({}),
					readTokenFromStdin: async () => "tok-from-stdin\n",
				},
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(loadWarrenClientConfigFromFile(env)?.token).toBe("tok-from-stdin");
		}));

	test("falls back to WARREN_API_TOKEN when not flagged", () =>
		withTempConfig(async (env) => {
			const { context } = captureContext({ ...env, WARREN_API_TOKEN: "tok-env" });
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient({}),
					readTokenFromStdin: async () => "",
				},
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(loadWarrenClientConfigFromFile(env)?.token).toBe("tok-env");
		}));

	test("a piped stdin token wins over an ambient env token and warns (warren-2244)", () =>
		withTempConfig(async (env) => {
			const recorded: { config?: WarrenClientConfig } = {};
			const { context, err } = captureContext({ ...env, WARREN_API_TOKEN: "tok-stale-env" });
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient(recorded),
					readTokenFromStdin: async () => "tok-piped\n",
				},
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(recorded.config?.token).toBe("tok-piped");
			expect(loadWarrenClientConfigFromFile(env)?.token).toBe("tok-piped");
			const warning = err.join("");
			expect(warning).toContain("using token piped on stdin");
			expect(warning).toContain("WARREN_API_TOKEN");
			expect(warning).not.toContain("tok-stale-env");
		}));

	test("skips the stdin warning when the piped token matches the env token", () =>
		withTempConfig(async (env) => {
			const { context, err } = captureContext({ ...env, WARREN_API_TOKEN: "tok-same" });
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient({}),
					readTokenFromStdin: async () => "tok-same\n",
				},
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(err.join("")).not.toContain("ignoring WARREN_API_TOKEN");
		}));

	test("--token still outranks both stdin and env", () =>
		withTempConfig(async (env) => {
			const recorded: { config?: WarrenClientConfig } = {};
			const { context } = captureContext({ ...env, WARREN_API_TOKEN: "tok-env" });
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient(recorded),
					readTokenFromStdin: async () => "tok-piped",
				},
				{ token: "tok-flag" },
			);
			expect(result.exitCode).toBe(0);
			expect(recorded.config?.token).toBe("tok-flag");
		}));

	test("fails with exit 2 when no token is available anywhere", () =>
		withTempConfig(async (env) => {
			const { context, err } = captureContext(env);
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient({}),
					readTokenFromStdin: async () => "",
				},
				{},
			);
			expect(result.exitCode).toBe(2);
			expect(err.join("")).toContain("no token supplied");
		}));

	test("maps a 401 from whoami to exit 4 and writes nothing", () =>
		withTempConfig(async (env, dir) => {
			const { context, err } = captureContext(env);
			const result = await runLogin(
				context,
				{
					resolveConfig: RESOLVE,
					makeClient: () => ({
						whoami: async () => {
							throw new WarrenClientError(401, "unauthorized", "bad token");
						},
					}),
					readTokenFromStdin: async () => "",
				},
				{ token: "tok-bad" },
			);
			expect(result.exitCode).toBe(4);
			expect(err.join("")).toContain("bad token");
			expect(
				loadWarrenClientConfigFromFile({ WARREN_CLIENT_CONFIG: join(dir, "client.json") }),
			).toBeUndefined();
		}));

	test("round-trips against a real test server (whoami → config file → reload)", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/whoami") {
					if (req.headers.get("authorization") !== "Bearer tok-live") {
						return Response.json({ error: "unauthorized" }, { status: 401 });
					}
					return Response.json({ identity: "operator", capabilities: ["dispatch"] });
				}
				return Response.json({ error: "not found" }, { status: 404 });
			},
		});
		const dir = await mkdtemp(join(tmpdir(), "warren-login-live-test-"));
		try {
			const env: Record<string, string> = { WARREN_CLIENT_CONFIG: join(dir, "client.json") };
			const { context, out } = captureContext(env);
			const baseUrl = `http://localhost:${server.port}`;
			const result = await runLogin(
				context,
				{
					resolveConfig: (a) => resolveClientConfig(env, a),
					makeClient: (config) => new WarrenClient({ config }),
					readTokenFromStdin: async () => "",
				},
				{ url: baseUrl, token: "tok-live" },
			);
			expect(result.exitCode).toBe(0);
			expect(out.join("")).not.toContain("tok-live");
			// The persisted config now resolves a working client with no flags.
			const reloaded = new WarrenClient({ config: resolveClientConfig(env, {}) });
			expect(reloaded.config.baseUrl).toBe(baseUrl);
			expect(reloaded.config.token).toBe("tok-live");
			const who = await reloaded.whoami();
			expect(who.identity).toBe("operator");
		} finally {
			server.stop(true);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("pretty mode renders a masked token summary", () =>
		withTempConfig(async (env) => {
			const { context, out } = { ...captureContext(env) };
			const prettyContext: CliContext = { ...context, output: "pretty" };
			const result = await runLogin(
				prettyContext,
				{
					resolveConfig: RESOLVE,
					makeClient: okClient({}),
					readTokenFromStdin: async () => "",
				},
				{ token: "tok-pretty-xyz" },
			);
			expect(result.exitCode).toBe(0);
			const text = out.join("");
			expect(text).toContain("✔ logged in");
			expect(text).toContain("tok-••••");
			expect(text).not.toContain("tok-pretty-xyz");
		}));
});
