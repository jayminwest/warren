import { type Issue, IssueNotFoundError, type IssueStatus } from "../core/wire.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunChildState, PlanRunRow } from "../db/schema.ts";
import { agents } from "../db/schema.ts";
import type { PrMergeChecker } from "../runs/pr-merge.ts";
import type { IssueTracker, TrackerCapabilities, TrackerContext } from "../tracker/contract.ts";
import type {
	CoordinatorEmitFn,
	CoordinatorGetIssueFn,
	CoordinatorSpawnFn,
} from "./coordinator.ts";

export const NOW = new Date("2026-05-17T00:00:00.000Z");

export interface CapturedEvent {
	runId: string;
	kind: string;
	payload: Record<string, unknown>;
}

/** Capabilities every coordinator test double carries (mirrors SeedsTracker). */
const FAKE_TRACKER_CAPABILITIES: TrackerCapabilities = {
	supportsPlans: true,
	supportsMetadata: true,
	supportsScheduledIssues: true,
	isGitNative: true,
};

/**
 * Fake-tracker unit double for the coordinator tests (warren-2d98): an
 * in-memory `IssueTracker` answering `getIssue` from a status map, with
 * dedicated not-found / transient modes for the terminal-vs-retryable
 * arms. The coordinator consumes the `getIssue` closure, so the harness
 * adapts the double onto `CoordinatorGetIssueFn`.
 */
export class FakeTracker implements IssueTracker {
	readonly capabilities = FAKE_TRACKER_CAPABILITIES;
	/** Issue ids whose reads throw a transient TrackerError-shaped failure. */
	readonly transient = new Set<string>();

	constructor(private readonly issues: ReadonlyMap<string, IssueStatus>) {}

	async getIssue(_ctx: TrackerContext, issueId: string): Promise<Issue> {
		if (this.transient.has(issueId)) throw new Error("tracker timed out");
		const status = this.issues.get(issueId) ?? this.issues.get("*");
		if (status === undefined) {
			throw new IssueNotFoundError(`Issue not found: ${issueId}`);
		}
		return { id: issueId, status };
	}

	async listIssueStatuses(): Promise<ReadonlyMap<string, IssueStatus>> {
		return this.issues;
	}

	async closeIssue(): Promise<void> {}
}

/** Adapt a FakeTracker onto the coordinator's getIssue seam. */
export function getIssueFromTracker(tracker: FakeTracker): CoordinatorGetIssueFn {
	return async (projectId, issueId) => tracker.getIssue({ projectId }, issueId);
}

export interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	planRun: PlanRunRow;
	events: CapturedEvent[];
	emit: CoordinatorEmitFn;
	getIssueStub: (status: "open" | "closed") => CoordinatorGetIssueFn;
	/** A getIssue that always throws IssueNotFoundError (warren-2a8c). */
	getIssueNotFound: CoordinatorGetIssueFn;
	/** A getIssue that always throws a transient (non-not-found) error. */
	getIssueTransient: CoordinatorGetIssueFn;
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
	const getIssueStub = (status: "open" | "closed"): CoordinatorGetIssueFn =>
		getIssueFromTracker(new FakeTracker(new Map([["*", status]])));
	const getIssueNotFound: CoordinatorGetIssueFn = getIssueFromTracker(new FakeTracker(new Map()));
	const getIssueTransient: CoordinatorGetIssueFn = async () => {
		throw new Error("tracker timed out");
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
		getIssueStub,
		getIssueNotFound,
		getIssueTransient,
		spawnStub,
		makeRun,
	};
}

export const neverPoll: PrMergeChecker = async () => {
	throw new Error("checkPrMerged should not be called in this branch");
};
