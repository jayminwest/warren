import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../../db/repos/projects.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { CliContext, SpawnResult } from "../output.ts";
import { runAddProject } from "./add-project.ts";

const CFG: ProjectsConfig = {
	root: "/tmp/projects-cli",
	gitBinary: "git",
};

function captureContext(spawnResults?: (cmd: readonly string[]) => SpawnResult): {
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
		spawn: async (cmd) =>
			spawnResults ? spawnResults(cmd) : { stdout: "", stderr: "", exitCode: 0 },
		now: () => new Date("2026-05-08T12:00:00.000Z"),
	};
	return { context, out, err };
}

describe("runAddProject", () => {
	let db: WarrenDb;
	let projects: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		projects = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("rejects an empty git url with exit 2", async () => {
		const { context, err } = captureContext();
		const result = await runAddProject(context, { projects, projectsConfig: CFG }, { gitUrl: "" });
		expect(result.exitCode).toBe(2);
		expect(err.join("")).toContain("git-url is required");
	});

	test("surfaces a ValidationError as exit 1 with the formatted message", async () => {
		const { context, err } = captureContext();
		const result = await runAddProject(
			context,
			{ projects, projectsConfig: CFG },
			{ gitUrl: "not-a-github-url" },
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("[validation_error]");
	});

	// warren-0883: the CLI used to bypass the public-instance allowlist
	// that `POST /projects` enforces. The allowlist is now forwarded into
	// `addProject` — the single enforcement site — so these pin the CLI
	// half of that contract.
	const PUBLIC_ALLOWLIST = {
		owners: new Set(["os-eco"]),
		repos: new Set<string>(),
	};

	test("public mode: refuses a non-allowlisted org with exit 1 and persists nothing", async () => {
		const { context, err } = captureContext();
		const result = await runAddProject(
			context,
			{ projects, projectsConfig: CFG, publicAllowlist: PUBLIC_ALLOWLIST },
			{ gitUrl: "https://github.com/somebody/private" },
		);
		expect(result.exitCode).toBe(1);
		expect(err.join("")).toContain("not on this public instance's allowlist");
		expect(await projects.findByGitUrl("https://github.com/somebody/private")).toBeNull();
	});

	test("public mode: admits an allowlisted org", async () => {
		const { context, out } = captureContext();
		const result = await runAddProject(
			context,
			{ projects, projectsConfig: CFG, publicAllowlist: PUBLIC_ALLOWLIST },
			{ gitUrl: "https://github.com/os-eco/warren", defaultBranch: "main" },
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(out.join("")).ok).toBe(true);
	});

	test("token mode: no allowlist dep stays permissive", async () => {
		const { context } = captureContext();
		const result = await runAddProject(
			context,
			{ projects, projectsConfig: CFG },
			{ gitUrl: "https://github.com/somebody/anything", defaultBranch: "main" },
		);
		expect(result.exitCode).toBe(0);
	});
});
