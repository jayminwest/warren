import { describe, expect, test } from "bun:test";
import {
	type VersionResponse,
	type WarrenClient,
	WarrenClientError,
	WarrenUnreachableError,
	type WhoamiResponse,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runRemoteDoctor } from "./doctor-remote.ts";

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
	readonly probeError?: Error;
	readonly whoamiError?: Error;
	readonly version?: string;
	readonly versionError?: Error;
}

/** Mocked WarrenClient (warren-97a2): the client half of doctor never touches a DB. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	return {
		config: { baseUrl: "http://localhost:8080" },
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
