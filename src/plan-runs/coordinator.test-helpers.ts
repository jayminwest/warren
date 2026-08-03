import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunChildState, PlanRunRow } from "../db/schema.ts";
import { agents } from "../db/schema.ts";
import { SeedNotFoundError } from "../seeds-cli/index.ts";
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
	/** A showSeed that always throws SeedNotFoundError (warren-2a8c). */
	showSeedNotFound: CoordinatorShowSeedFn;
	/** A showSeed that always throws a transient (non-not-found) error. */
	showSeedTransient: CoordinatorShowSeedFn;
	spawnStub: (newRunId: () => string) => CoordinatorSpawnFn;
	makeRun: (seedId: string) => Promise<string>;
	/**
	 * Drive a `pending` child to `state` through the legal transition path
	 * (warren-66d2). The repo now refuses shortcuts like pending → pr_open,
	 * so fixtures walk pending → dispatched → running → pr_open instead of
	 * writing the end state directly.
	 */
	seedChildState: (input: SeedChildStateInput) => Promise<void>;
}

export interface SeedChildStateInput {
	readonly planRunId: string;
	readonly seq: number;
	readonly state: PlanRunChildState;
	readonly runId?: string;
	readonly startedAt?: string;
	readonly prMergedAt?: string;
	readonly endedAt?: string;
}

const CHILD_PATH: Record<PlanRunChildState, readonly PlanRunChildState[]> = {
	pending: [],
	dispatched: ["dispatched"],
	running: ["dispatched", "running"],
	pr_open: ["dispatched", "running", "pr_open"],
	merged: ["dispatched", "running", "pr_open", "merged"],
	failed: ["dispatched", "failed"],
	skipped: ["skipped"],
};

function childStepPatch(
	input: SeedChildStateInput,
	step: PlanRunChildState,
): Record<string, unknown> {
	const patch: Record<string, unknown> = { state: step };
	if (input.runId !== undefined) patch.runId = input.runId;
	if (input.startedAt !== undefined) patch.startedAt = input.startedAt;
	if (step !== input.state) return patch;
	if (input.prMergedAt !== undefined) patch.prMergedAt = input.prMergedAt;
	if (input.endedAt !== undefined) patch.endedAt = input.endedAt;
	return patch;
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
	const showSeedNotFound: CoordinatorShowSeedFn = async (_projectId, seedId) => {
		throw new SeedNotFoundError(`Issue not found: ${seedId}`);
	};
	const showSeedTransient: CoordinatorShowSeedFn = async () => {
		throw new Error("sd timed out");
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
	const seedChildState = async (input: SeedChildStateInput): Promise<void> => {
		for (const step of CHILD_PATH[input.state]) {
			await repos.planRuns.updateChild({
				planRunId: input.planRunId,
				seq: input.seq,
				patch: childStepPatch(input, step),
			});
		}
	};
	return {
		db,
		repos,
		seedChildState,
		projectId: project.id,
		planRun,
		events,
		emit,
		showSeedStub,
		showSeedNotFound,
		showSeedTransient,
		spawnStub,
		makeRun,
	};
}

export const neverPoll: PrMergeChecker = async () => {
	throw new Error("checkPrMerged should not be called in this branch");
};
