import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { PI_BUILTIN } from "../../registry/builtins/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient } from "./test-helpers.ts";

const GIT_NATIVE_TRACKER: IssueTracker = {
	capabilities: {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: true,
	},
	getIssue: async () => {
		throw new Error("unused");
	},
	listIssueStatuses: async () => new Map(),
	closeIssue: async () => {},
};

describe("spawnRun: prompt-fragment gating (warren-cb46)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let clonePath: string;

	beforeEach(async () => {
		({ db, repos } = await openTestDb());
		await repos.agents.upsert({ name: "pi", renderedJson: PI_BUILTIN });
		clonePath = mkdtempSync(join(tmpdir(), "warren-prompt-gating-"));
	});

	afterEach(async () => {
		await db.close();
		rmSync(clonePath, { recursive: true, force: true });
	});

	test("capability-less project: no sd/ml/.seeds/.mulch text in the frozen prompt", async () => {
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: clonePath,
			defaultBranch: "main",
			hasSeeds: false,
		});
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			issueTracker: GIT_NATIVE_TRACKER,
		});

		const system = result.agent.sections.system ?? "";
		expect(system).not.toContain(".seeds");
		expect(system).not.toContain(".mulch");
		expect(system).not.toMatch(/`sd /);
		expect(system).not.toMatch(/`ml prime`/);
		// The composed body is what got frozen onto the run row.
		const stored = await repos.runs.require(result.run.id);
		const rendered = stored.renderedAgentJson as { sections: Record<string, string> };
		expect(rendered.sections.system).toBe(system);
		expect((rendered as { gatedPrompts?: unknown }).gatedPrompts).toBeUndefined();
		// ...and what got dispatched to the provider.
		const dispatchBody = client.calls[1]?.body as { prompt: string };
		expect(dispatchBody.prompt.startsWith(system)).toBe(true);
	});

	test("seeds+mulch project: tracker workflow and expertise text return", async () => {
		mkdirSync(join(clonePath, ".seeds"));
		mkdirSync(join(clonePath, ".mulch"));
		await repos.projects.create({
			id: "prj_xxxxxxxxxxxx",
			gitUrl: "https://github.com/x/y.git",
			localPath: clonePath,
			defaultBranch: "main",
			hasSeeds: true,
		});
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			issueTracker: GIT_NATIVE_TRACKER,
		});

		const system = result.agent.sections.system ?? "";
		expect(system).toContain(".seeds/issues.jsonl");
		expect(system).toContain(".mulch/expertise");
		expect(system).toMatch(/`ml prime`/);
	});
});

async function openTestDb(): Promise<{ db: WarrenDb; repos: Repos }> {
	const db = await openDatabase({ path: ":memory:" });
	return { db, repos: createRepos(db) };
}
