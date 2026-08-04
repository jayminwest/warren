import { describe, expect, test } from "bun:test";
import {
	type CreateProjectInput,
	type ProjectRow,
	type WarrenClient,
	WarrenClientError,
	WarrenUnreachableError,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runAddProject } from "./add-project.ts";

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
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

function projectRow(over: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: "prj_1",
		gitUrl: "https://github.com/os-eco/warren",
		localPath: "/data/projects/warren",
		defaultBranch: "main",
		addedAt: "2026-05-08T12:00:00.000Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasSeeds: false,
		...over,
	};
}

interface MockClientInput {
	readonly probeError?: Error;
	readonly createError?: Error;
	readonly row?: ProjectRow;
	readonly calls?: CreateProjectInput[];
}

/** Mocked WarrenClient (warren-97a2): command tests never touch a DB or a socket. */
function mockClient(input: MockClientInput = {}): WarrenClient {
	return {
		probe: async () => {
			if (input.probeError !== undefined) throw input.probeError;
		},
		createProject: async (body: CreateProjectInput) => {
			input.calls?.push(body);
			if (input.createError !== undefined) throw input.createError;
			return input.row ?? projectRow({ gitUrl: body.gitUrl });
		},
	} as unknown as WarrenClient;
}

describe("runAddProject", () => {
	test("rejects an empty git url with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runAddProject(context, { client: mockClient() }, { gitUrl: "" });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("git-url is required");
	});

	test("an unreachable server exits 3 with the probe error on stderr", async () => {
		const { context, err } = captureContext();
		const client = mockClient({ probeError: new WarrenUnreachableError("connection refused") });
		const result = await runAddProject(
			context,
			{ client },
			{ gitUrl: "https://github.com/os-eco/warren" },
		);
		expect(result.exitCode).toBe(3);
		expect(err.join("")).toContain("connection refused");
	});

	test("posts to /projects and prints the created row", async () => {
		const { context, out } = captureContext();
		const calls: CreateProjectInput[] = [];
		const result = await runAddProject(
			context,
			{ client: mockClient({ calls }) },
			{ gitUrl: "https://github.com/os-eco/warren", defaultBranch: "trunk" },
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([{ gitUrl: "https://github.com/os-eco/warren", defaultBranch: "trunk" }]);
		const line = JSON.parse(out.join(""));
		expect(line.ok).toBe(true);
		expect(line.project.id).toBe("prj_1");
	});

	test("omits defaultBranch from the body when the flag is absent", async () => {
		const { context } = captureContext();
		const calls: CreateProjectInput[] = [];
		const result = await runAddProject(
			context,
			{ client: mockClient({ calls }) },
			{ gitUrl: "https://github.com/os-eco/warren" },
		);
		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([{ gitUrl: "https://github.com/os-eco/warren" }]);
	});

	test("surfaces a server-side validation error as exit 1", async () => {
		const { context, err } = captureContext();
		const client = mockClient({
			createError: new WarrenClientError(400, "validation_error", "not a GitHub URL"),
		});
		const result = await runAddProject(context, { client }, { gitUrl: "not-a-github-url" });
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("not a GitHub URL");
	});

	// warren-0883 / warren-97a2: the public-instance allowlist is enforced
	// server-side by POST /projects; the CLI surfaces the refusal verbatim.
	test("surfaces a public-allowlist refusal from the server", async () => {
		const { context, err } = captureContext();
		const client = mockClient({
			createError: new WarrenClientError(
				403,
				"forbidden",
				"org is not on this public instance's allowlist",
			),
		});
		const result = await runAddProject(
			context,
			{ client },
			{ gitUrl: "https://github.com/somebody/private" },
		);
		expect(result.exitCode).toBe(4);
		expect(err.join("")).toContain("allowlist");
	});
});

describe("runAddProject output contract (warren-b61e)", () => {
	test("json mode emits a single indented document", async () => {
		const { context, out } = captureContext();
		const result = await runAddProject(
			{ ...context, output: "json" },
			{ client: mockClient() },
			{ gitUrl: "https://github.com/os-eco/warren" },
		);
		expect(result.exitCode).toBe(0);
		expect(out.join("")).toContain('\n  "ok": true');
	});

	test("pretty mode emits the human line", async () => {
		const { context, out } = captureContext();
		const result = await runAddProject(
			{ ...context, output: "pretty" },
			{ client: mockClient() },
			{ gitUrl: "https://github.com/os-eco/warren" },
		);
		expect(result.exitCode).toBe(0);
		expect(out.join("")).toContain("✔ project prj_1 registered");
	});
});
