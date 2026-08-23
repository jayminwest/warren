import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type VersionResponse,
	type WarrenClient,
	WarrenClientError,
	WarrenUnreachableError,
	type WhoamiResponse,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { remoteDoctorDeps, runRemoteDoctor } from "./doctor-remote.ts";

// Point the config-file slot at a path that cannot exist, so a real
// `~/.warren/client.json` on the dev machine (written by `warren login`)
// never leaks into tests that exercise the built-in default. Same constant
// and same hazard as `src/cli/client.test.ts`: `remoteDoctorDeps` runs the
// real resolution chain, so without this the test fails on a corrupt file
// that has nothing to do with the code under test (warren-3f76).
const NO_CONFIG_FILE = { WARREN_CLIENT_CONFIG: join(tmpdir(), "warren-client-test-absent.json") };

function captureContext(): { context: CliContext; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	return { context, out, err };
}

interface MockClientInput {
	readonly baseUrl?: string;
	readonly probeError?: Error;
	readonly whoamiError?: Error;
	readonly version?: string;
	readonly versionError?: Error;
}

/** Mocked WarrenClient (warren-97a2): the client half of doctor never touches a DB. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	return {
		config: { baseUrl: input.baseUrl ?? "http://localhost:8080" },
		probe: async () => {
			if (input.probeError !== undefined) throw input.probeError;
		},
		whoami: async (): Promise<WhoamiResponse> => {
			if (input.whoamiError !== undefined) throw input.whoamiError;
			return { identity: "operator", capabilities: ["readOperator", "dispatch"] };
		},
		version: async (): Promise<VersionResponse> => {
			if (input.versionError !== undefined) throw input.versionError;
			return { version: input.version ?? "1.2.3" };
		},
	} as unknown as WarrenClient;
}

describe("runRemoteDoctor", () => {
	test("healthy server: three ok checks and exit 0", async () => {
		const { context, out } = captureContext();
		const result = await runRemoteDoctor(
			context,
			{ client: mockClient({ version: "1.2.3" }), cliVersion: "1.2.3" },
			{},
		);
		expect(result.exitCode).toBe(0);
		expect(result.checks.map((c) => c.name)).toEqual([
			"server_reachable",
			"auth_valid",
			"version_match",
		]);
		expect(result.checks.every((c) => c.ok)).toBe(true);
		expect(out.join("")).toContain("server_reachable");
	});

	test("unreachable server: one failed check, auth + version skipped, exit 1", async () => {
		const { context, err } = captureContext();
		const client = mockClient({ probeError: new WarrenUnreachableError("connection refused") });
		const result = await runRemoteDoctor(context, { client }, {});
		expect(result.exitCode).toBe(1);
		expect(result.checks.map((c) => c.name)).toEqual(["server_reachable"]);
		expect(result.checks[0]?.hint).toContain("WARREN_BASE_URL");
		expect(err.join("")).toContain("one or more checks failed");
	});

	test("a rejected token fails auth_valid with a token hint", async () => {
		const { context } = captureContext();
		const client = mockClient({
			whoamiError: new WarrenClientError(401, "unauthorized", "bad token"),
		});
		const result = await runRemoteDoctor(context, { client }, {});
		expect(result.exitCode).toBe(1);
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.ok).toBe(false);
		expect(auth?.hint).toContain("WARREN_API_TOKEN");
		expect(auth?.hint).toContain("warren login");
	});

	test("the unreachable hint names the slot the base URL came from (warren-4f1b)", async () => {
		const { context } = captureContext();
		const configAt = join(tmpdir(), "warren-doctor-config.json");
		const client = mockClient({
			baseUrl: "https://stale.example.com",
			probeError: new WarrenUnreachableError("connection refused"),
		});
		const result = await runRemoteDoctor(
			{ ...context, env: { WARREN_CLIENT_CONFIG: configAt } },
			{ client, baseUrlSource: "config-file" },
			{},
		);
		const hint = result.checks[0]?.hint ?? "";
		expect(hint).toContain("https://stale.example.com");
		expect(hint).toContain("came from the client config file");
		// The resolved path, not a hard-coded ~/.warren/client.json.
		expect(hint).toContain(configAt);
		// And no longer the two slots that did not supply it.
		expect(hint).not.toContain("WARREN_BASE_URL");
		expect(hint).not.toContain("--url");
	});

	test("the unreachable hint says so when no slot supplied a base URL (warren-4f1b)", async () => {
		const { context } = captureContext();
		const client = mockClient({ probeError: new WarrenUnreachableError("connection refused") });
		const result = await runRemoteDoctor(context, { client, baseUrlSource: "default" }, {});
		const hint = result.checks[0]?.hint ?? "";
		expect(hint).toContain("built-in default");
		expect(hint).toContain("WARREN_BASE_URL");
	});

	test("the auth line names the resolved config path, not the default (warren-4f1b)", async () => {
		const { context } = captureContext();
		const configAt = join(tmpdir(), "warren-doctor-config.json");
		const result = await runRemoteDoctor(
			{ ...context, env: { WARREN_CLIENT_CONFIG: configAt } },
			{ client: mockClient({}), tokenSource: "config-file" },
			{},
		);
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.message).toContain(configAt);
		expect(auth?.message).not.toContain("~/.warren/client.json");
	});

	test("remoteDoctorDeps carries the slots the resolution picked (warren-8807)", () => {
		const deps = remoteDoctorDeps(
			{
				...NO_CONFIG_FILE,
				WARREN_BASE_URL: "https://env.example.com",
				WARREN_API_TOKEN: "tok-env",
			},
			{},
		);
		expect(deps.client.config.baseUrl).toBe("https://env.example.com");
		expect(deps.baseUrlSource).toBe("env");
		expect(deps.tokenSource).toBe("env");
	});

	test("the reachability line names where the base URL came from (warren-8807)", async () => {
		const { context } = captureContext();
		const result = await runRemoteDoctor(
			context,
			{
				client: mockClient({ version: "1.2.3" }),
				cliVersion: "1.2.3",
				baseUrlSource: "default",
			},
			{},
		);
		const reachable = result.checks.find((c) => c.name === "server_reachable");
		expect(reachable?.message).toContain("http://localhost:8080");
		expect(reachable?.message).toContain("built-in default");
	});

	test("the ok line names the slot the token came from (warren-8807)", async () => {
		const { context } = captureContext();
		const result = await runRemoteDoctor(
			context,
			{ client: mockClient({ version: "1.2.3" }), cliVersion: "1.2.3", tokenSource: "env" },
			{},
		);
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.ok).toBe(true);
		expect(auth?.message).toContain("admitted as operator");
		expect(auth?.message).toContain("WARREN_API_TOKEN");
	});

	test("a rejected token names its slot in the hint (warren-8807)", async () => {
		const { context } = captureContext();
		const client = mockClient({
			whoamiError: new WarrenClientError(401, "unauthorized", "bad token"),
		});
		const result = await runRemoteDoctor(context, { client, tokenSource: "env" }, {});
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.ok).toBe(false);
		expect(auth?.hint).toContain("rejected token came from WARREN_API_TOKEN");
		expect(auth?.hint).toContain(".env");
	});

	test("a rejected --token is not blamed on the environment (warren-8807)", async () => {
		const { context } = captureContext();
		const client = mockClient({
			whoamiError: new WarrenClientError(401, "unauthorized", "bad token"),
		});
		const result = await runRemoteDoctor(context, { client, tokenSource: "flag" }, {});
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.hint).toContain("rejected token came from --token");
	});

	test("a rejected config-file token points back at warren login (warren-8807)", async () => {
		const { context } = captureContext();
		const client = mockClient({
			whoamiError: new WarrenClientError(401, "unauthorized", "bad token"),
		});
		const result = await runRemoteDoctor(context, { client, tokenSource: "config-file" }, {});
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.hint).toContain("rejected token came from the client config file");
		expect(auth?.hint).toContain("warren login");
	});

	test("--no-auth skips the auth check", async () => {
		const { context } = captureContext();
		const result = await runRemoteDoctor(
			context,
			{ client: mockClient({ version: "1.2.3" }), cliVersion: "1.2.3" },
			{ noAuth: true },
		);
		expect(result.exitCode).toBe(0);
		const auth = result.checks.find((c) => c.name === "auth_valid");
		expect(auth?.ok).toBe(true);
		expect(auth?.message).toContain("skipped");
	});

	test("a version skew fails version_match with an upgrade hint", async () => {
		const { context } = captureContext();
		const result = await runRemoteDoctor(
			context,
			{ client: mockClient({ version: "9.9.9" }), cliVersion: "1.2.3" },
			{},
		);
		expect(result.exitCode).toBe(1);
		const version = result.checks.find((c) => c.name === "version_match");
		expect(version?.ok).toBe(false);
		expect(version?.message).toContain("cli is 1.2.3 but server is 9.9.9");
		expect(version?.hint).toContain("upgrade");
	});
});
