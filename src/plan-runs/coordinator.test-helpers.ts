import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import { agents } from "../db/schema.ts";
import type {
	CoordinatorEmitFn,
	CoordinatorShowSeedFn,
	CoordinatorSpawnFn,
} from "./coordinator.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

export const NOW = new Date("2026-05-17T00:00:00.000Z");

export interface CapturedEvent {
	runId: string;
	kind: string;
	payload: Record<string, unknown>;
}

export interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	planRun: PlanRunRow;
	events: CapturedEvent[];
	emit: CoordinatorEmitFn;
	showSeedStub: (status: "open" | "closed") => CoordinatorShowSeedFn;
	spawnStub: (newRunId: () => string) => CoordinatorSpawnFn;
	makeRun: (seedId: string) => Promise<string>;
}

export async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	db.drizzle
		.insert(agents)
		.values({
			name: "claude-code",
			renderedJson: { sections: {} },
			registeredAt: "2026-05-10T00:00:00.000Z",
			lastRefreshed: "2026-05-10T00:00:00.000Z",
		})
		.run();
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const { planRun } = await repos.planRuns.create({
		planId: "pl-acc",
		projectId: project.id,
		agentName: "claude-code",
		children: [
			{ seq: 1, seedId: "warren-a" },
			{ seq: 2, seedId: "warren-b" },
		],
		now: NOW,
	});
	const events: CapturedEvent[] = [];
	const emit: CoordinatorEmitFn = async (runId, kind, payload) => {
		events.push({ runId, kind, payload });
	};
	const showSeedStub = (status: "open" | "closed"): CoordinatorShowSeedFn => {
		return async (_projectId, seedId) => ({ id: seedId, status });
	};
	const spawnStub = (newRunId: () => string): CoordinatorSpawnFn => {
		return async ({ child, prompt }) => {
			const run = await repos.runs.create({
				agentName: "claude-code",
				projectId: project.id,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
				now: NOW,
			});
			void newRunId;
			return { runId: run.id };
		};
	};
	const makeRun = async (seedId: string): Promise<string> => {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: `work on sd ${seedId}`,
			renderedAgentJson: { sections: {} },
			trigger: "plan-run",
			seedId,
			now: NOW,
		});
		return run.id;
	};
	return {
		db,
		repos,
		projectId: project.id,
		planRun,
		events,
		emit,
		showSeedStub,
		spawnStub,
		makeRun,
	};
}

export const neverPoll: PrMergeChecker = async () => {
	throw new Error("checkPrMerged should not be called in this branch");
};
