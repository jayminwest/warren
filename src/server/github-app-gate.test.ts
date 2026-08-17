import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../runs/index.ts";
import { FakeProvider } from "../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import {
	GITHUB_APP_REGISTRATION_ENV,
	resolveGitHubAppRegistrationGate,
} from "./github-app-gate.ts";
import { startServer } from "./server.ts";
import type { ServeHandle, ServeOptions, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

describe("resolveGitHubAppRegistrationGate", () => {
	test("explicit on wins over every default-off condition", () => {
		const gate = resolveGitHubAppRegistrationGate({
			[GITHUB_APP_REGISTRATION_ENV]: "on",
			WARREN_AUTH: "public",
			WARREN_FORGE: "app",
		});
		expect(gate.enabled).toBe(true);
		expect(gate.reason).toContain("explicit");
	});

	test("explicit off wins on a private first-boot instance", () => {
		const gate = resolveGitHubAppRegistrationGate({
			[GITHUB_APP_REGISTRATION_ENV]: "off",
		});
		expect(gate.enabled).toBe(false);
		expect(gate.reason).toContain("explicit");
	});

	test("the explicit value is case-insensitive and trimmed", () => {
		expect(
			resolveGitHubAppRegistrationGate({ [GITHUB_APP_REGISTRATION_ENV]: "  ON  " }).enabled,
		).toBe(true);
	});

	test("an unrecognized explicit value refuses the boot (fail loud)", () => {
		expect(() =>
			resolveGitHubAppRegistrationGate({ [GITHUB_APP_REGISTRATION_ENV]: "maybe" }),
		).toThrow(ValidationError);
	});

	test("default OFF when WARREN_AUTH=public", () => {
		const gate = resolveGitHubAppRegistrationGate({ WARREN_AUTH: "public" });
		expect(gate.enabled).toBe(false);
		expect(gate.reason).toContain("WARREN_AUTH=public");
	});

	test("default OFF when WARREN_FORGE=app is configured", () => {
		const gate = resolveGitHubAppRegistrationGate({ WARREN_FORGE: "app" });
		expect(gate.enabled).toBe(false);
		expect(gate.reason).toContain("WARREN_FORGE=app");
	});

	test("default ON only for a private instance without App credentials", () => {
		const gate = resolveGitHubAppRegistrationGate({});
		expect(gate.enabled).toBe(true);
		expect(gate.reason).toContain("first-boot");
	});

	test("blank explicit value falls through to the default derivation", () => {
		expect(
			resolveGitHubAppRegistrationGate({
				[GITHUB_APP_REGISTRATION_ENV]: "   ",
				WARREN_AUTH: "public",
			}).enabled,
		).toBe(false);
	});
});

/**
 * Wire-level proof that a gated-off route answers 404 — never 401/403 —
 * and that the SAME request with the gate on reaches the real handler.
 */
describe("/github-app/* registration gate (wire)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function depsWithGate(enabled: boolean): ServerDeps {
		const runtimeProvider = new FakeProvider();
		const broker = new RunEventBroker();
		return {
			repos,
			runtimeProvider,
			forge: new FakeForge(),
			gitHubAppRegistration: { enabled, reason: "test" },
			broker,
			bridges: createBridgeRegistry({
				repos,
				broker,
				runtimeProvider,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
			projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
			logger: silentLogger,
			uiDistDir: null,
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};
	}

	const tcpOpts: ServeOptions = {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: NO_AUTH,
		logger: silentLogger,
	};

	function baseUrl(h: ServeHandle): string {
		if (h.transport.kind !== "tcp") throw new Error("expected tcp transport");
		return `http://${h.transport.hostname}:${h.transport.port}`;
	}

	test("gated off: /github-app/register and /github-app/callback answer 404", async () => {
		handle = startServer(depsWithGate(false), tcpOpts);
		const base = baseUrl(handle);
		for (const path of ["/github-app/register", "/github-app/callback"]) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error?: { code?: string } };
			expect(body.error?.code).toBe("not_found");
		}
	});

	test("gated on: the routes reach their real handlers", async () => {
		handle = startServer(depsWithGate(true), tcpOpts);
		const base = baseUrl(handle);
		const register = await fetch(`${base}/github-app/register`);
		expect(register.status).toBe(200);
		// A bare callback hit answers the handler's own 400 (no live nonce).
		const callback = await fetch(`${base}/github-app/callback`);
		expect(callback.status).toBe(400);
	});
});
