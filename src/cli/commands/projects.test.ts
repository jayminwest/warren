import { describe, expect, test } from "bun:test";
import { WarrenClientError } from "../../client/errors.ts";
import type { WarrenClient } from "../../client/index.ts";
import type { ListProjectsResponse, ProjectRow } from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import { runProjects } from "./projects.ts";

function captureContext(output?: CliContext["output"]): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		...(output !== undefined ? { output } : {}),
	};
	return { context, out, err };
}

function parseLines(chunks: string[]): unknown[] {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function projectRow(over: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: "prj_1",
		gitUrl: "https://github.com/acme/widgets",
		localPath: "/srv/clones/prj_1",
		defaultBranch: "main",
		addedAt: "2026-08-01T00:00:00.000Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasSeeds: false,
		...over,
	};
}

function projectsClient(projects: ProjectRow[] = []): WarrenClient {
	return {
		listProjects: async (): Promise<ListProjectsResponse> => ({ projects }),
	} as unknown as WarrenClient;
}

describe("runProjects", () => {
	test("ndjson-emits-one-trimmed-row-per-project", async () => {
		const { context, out } = captureContext("ndjson");
		const client = projectsClient([
			projectRow(),
			projectRow({ id: "prj_2", gitUrl: "git@github.com:acme/gadgets", defaultBranch: "dev" }),
		]);
		const res = await runProjects(context, { client });
		expect(res).toEqual({ exitCode: 0, count: 2 });
		expect(parseLines(out)).toEqual([
			{ id: "prj_1", gitUrl: "https://github.com/acme/widgets", defaultBranch: "main" },
			{ id: "prj_2", gitUrl: "git@github.com:acme/gadgets", defaultBranch: "dev" },
		]);
	});

	test("pretty-renders-an-aligned-table", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runProjects(context, { client: projectsClient([projectRow()]) });
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toContain("id");
		expect(text).toContain("prj_1");
		expect(text).toContain("https://github.com/acme/widgets");
		expect(text).toContain("main");
		expect(text).not.toContain('"gitUrl"');
	});

	test("pretty-reports-an-empty-registry", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runProjects(context, { client: projectsClient() });
		expect(res).toEqual({ exitCode: 0, count: 0 });
		expect(out.join("")).toContain("(no projects registered)");
	});

	test("maps-an-auth-rejection-to-exit-4", async () => {
		const { context, err } = captureContext("ndjson");
		const client = {
			listProjects: async (): Promise<ListProjectsResponse> => {
				throw new WarrenClientError(401, "unauthorized", "invalid token");
			},
		} as unknown as WarrenClient;
		const res = await runProjects(context, { client });
		expect(res.exitCode).toBe(4);
		expect(err.join("")).toContain("invalid token");
	});

	test("blames the slot the rejected token came from (warren-2d4c)", async () => {
		const { context, err } = captureContext("ndjson");
		const rejecting = {
			listProjects: async (): Promise<ListProjectsResponse> => {
				throw new WarrenClientError(401, "unauthorized", "invalid token");
			},
		} as unknown as WarrenClient;
		const res = await runProjects({ ...context, tokenSource: "flag" }, { client: rejecting });
		expect(res.exitCode).toBe(4);
		expect(err.join("")).toContain("token came from --token");
	});
});
