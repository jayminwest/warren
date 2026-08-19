import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { DEFAULT_PLAN_RUN_PROMPT_TEMPLATE } from "../core/plan-run-prompt.ts";
import type {
	Issue,
	IssueStatus,
	Plan,
	PlanStatus,
	PlanSummary,
	TrackerContext,
} from "../core/wire.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import type { IssueTracker, PlanCapableTracker } from "../tracker/contract.ts";
import { SeedsTracker } from "../tracker/seeds-tracker.ts";
import { createPlanRun } from "./create.ts";
import { PlanHasNoOpenChildrenError, ProjectLacksTrackerError } from "./errors.ts";

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
		issueTracker: new SeedsTracker(
			sdFor("pl-acc", "active", { "wa-a": "open", "wa-b": "open", "wa-c": "closed" }),
		),
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

	test("throws ProjectLacksTrackerError when the git-native project has no .seeds/", async () => {
		await expect(
			createPlanRun({ ...baseInput(), projectId: bareProjectId }),
		).rejects.toBeInstanceOf(ProjectLacksTrackerError);
	});

	test("throws ValidationError when the issue tracker is unwired", async () => {
		await expect(createPlanRun({ ...baseInput(), issueTracker: undefined })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("rejects a plan in a non-accepted status", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				planId: "pl-draft",
				issueTracker: new SeedsTracker(sdFor("pl-draft", "draft", { "wa-a": "open" })),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects a plan with no children", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				issueTracker: new SeedsTracker(sdFor("pl-acc", "active", {})),
			}),
		).rejects.toBeInstanceOf(PlanHasNoOpenChildrenError);
	});

	test("rejects a plan whose children are all closed", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				issueTracker: new SeedsTracker(
					sdFor("pl-acc", "done", { "wa-a": "closed", "wa-b": "closed" }),
				),
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

	test("a non-git-native tracker skips the hasSeeds gate and the clone refresh (warren-2d98)", async () => {
		const refreshed: string[] = [];
		const result = await createPlanRun({
			...baseInput(),
			projectId: bareProjectId,
			issueTracker: new RemoteFakeTracker("pl-acc", "active", ["wa-a", "wa-b"]),
			spawn: stubSpawn([]),
			refreshProjectFn: async (input) => {
				refreshed.push(input.id);
				const project = await repos.projects.require(input.id);
				return { project, headSha: "abc", ref: project.defaultBranch };
			},
		});
		expect(refreshed).toEqual([]);
		expect(result.planRun.projectId).toBe(bareProjectId);
		expect(result.children).toHaveLength(2);
	});

	test("rejects when the tracker lacks plan support (warren-2d98)", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				issueTracker: new RemoteFakeTracker("pl-acc", "active", ["wa-a"], {
					supportsPlans: false,
				}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	/* ----------------- the issues form (warren-de42) ----------------- */

	test("creates a plan-run from an ordered issue list against SeedsTracker", async () => {
		const result = await createPlanRun({
			...baseInput(),
			planId: undefined,
			issues: ["wa-a", "wa-b"],
		});
		expect(result.planRun.planId).toBeNull();
		expect(result.planRun.source).toBe("issues");
		expect(result.children.map((c) => ({ seq: c.seq, seedId: c.seedId }))).toEqual([
			{ seq: 1, seedId: "wa-a" },
			{ seq: 2, seedId: "wa-b" },
		]);
		const next = await repos.planRuns.pickNextPending(result.planRun.id);
		expect(next?.seedId).toBe("wa-a");
	});

	test("creates a plan-run from an issue list against a plans-incapable tracker (warren-de42)", async () => {
		const result = await createPlanRun({
			...baseInput(),
			projectId: bareProjectId,
			planId: undefined,
			issues: ["gh-1", "gh-2"],
			issueTracker: new RemoteFakeTracker("pl-acc", "active", [], {
				supportsPlans: false,
			}),
		});
		expect(result.planRun.source).toBe("issues");
		expect(result.planRun.planId).toBeNull();
		expect(result.children.map((c) => c.seedId)).toEqual(["gh-1", "gh-2"]);
	});

	test("rejects when both planId and issues are set", async () => {
		await expect(createPlanRun({ ...baseInput(), issues: ["wa-a"] })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("rejects when neither planId nor issues is set", async () => {
		await expect(createPlanRun({ ...baseInput(), planId: undefined })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("rejects an empty issues list", async () => {
		await expect(
			createPlanRun({ ...baseInput(), planId: undefined, issues: [] }),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects a duplicate id in the issues list", async () => {
		await expect(
			createPlanRun({ ...baseInput(), planId: undefined, issues: ["wa-a", "wa-a"] }),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects an issues list whose every issue is closed", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				planId: undefined,
				issues: ["wa-c"],
				issueTracker: new SeedsTracker(
					sdFor("pl-acc", "active", { "wa-a": "open", "wa-b": "open", "wa-c": "closed" }),
				),
			}),
		).rejects.toBeInstanceOf(PlanHasNoOpenChildrenError);
	});

	test("rejects an issues list containing an unknown issue id", async () => {
		await expect(
			createPlanRun({
				...baseInput(),
				planId: undefined,
				issues: ["wa-a", "wa-missing"],
			}),
		).rejects.toThrow();
	});
});

/** Fake hosted (non-git-native) tracker double for the domain tests (warren-2d98). */
class RemoteFakeTracker implements IssueTracker, PlanCapableTracker {
	readonly capabilities;
	constructor(
		_planId: string,
		private readonly planStatus: PlanStatus,
		private readonly children: readonly string[],
		caps?: { supportsPlans?: boolean },
	) {
		this.capabilities = {
			supportsPlans: caps?.supportsPlans ?? true,
			supportsMetadata: false,
			supportsScheduledIssues: false,
			isGitNative: false,
		};
	}
	async getIssue(_ctx: TrackerContext, issueId: string): Promise<Issue> {
		return { id: issueId, status: "open" };
	}
	async listIssueStatuses(_ctx: TrackerContext): Promise<ReadonlyMap<string, IssueStatus>> {
		return new Map();
	}
	async closeIssue(): Promise<void> {}
	async listPlans(): Promise<readonly PlanSummary[]> {
		return [];
	}
	async getPlan(_ctx: TrackerContext, _planId: string): Promise<Plan> {
		return { id: "pl", status: this.planStatus, children: this.children };
	}
}
