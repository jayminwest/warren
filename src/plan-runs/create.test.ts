import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { DEFAULT_PLAN_RUN_PROMPT_TEMPLATE } from "../core/plan-run-prompt.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import { createPlanRun } from "./create.ts";
import { PlanHasNoOpenChildrenError, ProjectLacksSeedsError } from "./errors.ts";

/* ----------------------------------------------------------------------- */
/* Stubs (mirror the seeds CLI's wire envelopes without shelling out)       */
/* ----------------------------------------------------------------------- */

function stubSpawn(
	responses: { match: (cmd: readonly string[]) => boolean; result: SpawnResult }[],
): SpawnFn {
	return async (cmd: readonly string[], _opts: SpawnOptions): Promise<SpawnResult> => {
		const matched = responses.find((r) => r.match(cmd));
		if (matched !== undefined) return matched.result;
		return { stdout: "", stderr: `no stub for ${cmd.join(" ")}`, exitCode: 1 };
	};
}

function planShow(planId: string, status: string, children: string[]): SpawnResult {
	return {
		stdout: JSON.stringify({
			success: true,
			plan: {
				id: planId,
				status,
				children,
				sections: { steps: children.map((title) => ({ title, blocks: [] })) },
			},
		}),
		stderr: "",
		exitCode: 0,
	};
}

function seedShow(id: string, status: "open" | "closed"): SpawnResult {
	return {
		stdout: JSON.stringify({ success: true, issue: { id, status, blockedBy: [] } }),
		stderr: "",
		exitCode: 0,
	};
}

function sdFor(planId: string, planStatus: string, children: Record<string, "open" | "closed">) {
	const responses = [
		{
			match: (cmd: readonly string[]) => cmd[1] === "plan" && cmd[2] === "show",
			result: planShow(planId, planStatus, Object.keys(children)),
		},
		...Object.entries(children).map(([seedId, status]) => ({
			match: (cmd: readonly string[]) => cmd[1] === "show" && cmd[2] === seedId,
			result: seedShow(seedId, status),
		})),
	];
	return { sdBinary: "sd", spawn: stubSpawn(responses) };
}

describe("createPlanRun", () => {
	let db: WarrenDb;
	let repos: Repos;
	let bareProjectId = "";
	let seedyProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "you are claude" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		bareProjectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/x/bare.git",
				localPath: "/tmp/bare",
				defaultBranch: "main",
				hasSeeds: false,
			})
		).id;
		seedyProjectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/x/seedy.git",
				localPath: "/tmp/seedy",
				defaultBranch: "main",
				hasSeeds: true,
			})
		).id;
	});

	afterEach(async () => {
		await db.close();
	});

	const baseInput = () => ({
		projectId: seedyProjectId,
		planId: "pl-acc",
		agentName: "claude-code",
		repos,
		seedsCli: sdFor("pl-acc", "active", { "wa-a": "open", "wa-b": "open", "wa-c": "closed" }),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
	});

	test("persists plan_run + children in one create and returns both", async () => {
		const result = await createPlanRun(baseInput());
		expect(result.planRun.planId).toBe("pl-acc");
		expect(result.planRun.agentName).toBe("claude-code");
		expect(result.planRun.state).toBe("queued");
		expect(result.planRun.promptTemplate).toBe(DEFAULT_PLAN_RUN_PROMPT_TEMPLATE);
		expect(result.children.map((c) => ({ seq: c.seq, seedId: c.seedId }))).toEqual([
			{ seq: 1, seedId: "wa-a" },
			{ seq: 2, seedId: "wa-b" },
			{ seq: 3, seedId: "wa-c" },
		]);
		const next = await repos.planRuns.pickNextPending(result.planRun.id);
		expect(next?.seedId).toBe("wa-a");
	});

	test("throws NotFoundError for an unknown project", async () => {
		await expect(createPlanRun({ ...baseInput(), projectId: "pr_missing" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("throws ProjectLacksSeedsError when the project has no .seeds/", async () => {
		await expect(
			createPlanRun({ ...baseInput(), projectId: bareProjectId }),
		).rejects.toBeInstanceOf(ProjectLacksSeedsError);
	});

	test("throws ValidationError when the seeds CLI is unwired", async () => {
		await expect(createPlanRun({ ...baseInput(), seedsCli: undefined })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("rejects a plan in a non-accepted status", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				planId: "pl-draft",
				seedsCli: sdFor("pl-draft", "draft", { "wa-a": "open" }),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects a plan with no children", async () => {
		await expect(
			createPlanRun({ ...baseInput(), seedsCli: sdFor("pl-acc", "active", {}) }),
		).rejects.toBeInstanceOf(PlanHasNoOpenChildrenError);
	});

	test("rejects a plan whose children are all closed", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				seedsCli: sdFor("pl-acc", "done", { "wa-a": "closed", "wa-b": "closed" }),
			}),
		).rejects.toBeInstanceOf(PlanHasNoOpenChildrenError);
	});

	test("throws NotFoundError for an unknown agent", async () => {
		await expect(createPlanRun({ ...baseInput(), agentName: "nope" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("rejects a promptTemplate without the seed-id placeholder (warren-b3be)", async () => {
		await expect(
			createPlanRun({ ...baseInput(), promptTemplate: "work on stuff" }),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("forwards overrides and dispatcherHandle into the persisted row", async () => {
		const result = await createPlanRun({
			...baseInput(),
			ref: "feature/x",
			providerOverride: "anthropic",
			modelOverride: "claude-opus-4",
			dispatcherHandle: "warren-fc12",
		});
		expect(result.planRun.ref).toBe("feature/x");
		expect(result.planRun.providerOverride).toBe("anthropic");
		expect(result.planRun.modelOverride).toBe("claude-opus-4");
		expect(result.planRun.dispatcherHandle).toBe("warren-fc12");
	});

	test("refreshes the host clone before the plan walk when the spawn seam is wired (warren-6d60)", async () => {
		const refreshed: string[] = [];
		const result = await createPlanRun({
			...baseInput(),
			spawn: stubSpawn([]),
			refreshProjectFn: async (input) => {
				refreshed.push(input.id);
				const project = await repos.projects.require(input.id);
				return { project, headSha: "abc", ref: project.defaultBranch };
			},
		});
		expect(refreshed).toEqual([seedyProjectId]);
		expect(result.planRun.projectId).toBe(seedyProjectId);
	});
});
