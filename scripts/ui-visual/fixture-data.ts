/**
 * Seed data for the ui-visual fixture boot (warren-010b).
 *
 * Writes warren's own repos BEFORE the server boots, the way acceptance
 * scenario 39 seeds its public instance. Every id is a fixed literal and
 * every timestamp derives from {@link FIXTURE_NOW_MS}, so two boots render
 * byte-identical pages: the golden screenshots (warren-a132) depend on it.
 *
 * Ids follow `src/core/ids.ts` (prefix + 12 base32 chars) so they pass
 * `isId` wherever a handler checks the shape. The contract the harness
 * reads is {@link FixtureIds}; `fixture-boot.ts` documents it.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { PlanRunChildState, RunFailureReason, RunState } from "../../src/core/wire.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createRepos, type Repos } from "../../src/db/repos/index.ts";
import { BUILTIN_AGENTS, stampAgentSource } from "../../src/registry/builtins/index.ts";
import { appendWithToolCalls, historyRunEvents, runningRunEvents } from "./fixture-events.ts";
import {
	AGENT_JSON,
	DAY_MS,
	FIXTURE_NOW_MS,
	fxId,
	MINUTE_MS,
	minutesAgo,
	OWNER,
	prUrlFor,
	type RunSpec,
	SEEDS_REPO,
	seedRun,
} from "./fixture-runs.ts";

export { FIXTURE_NOW_ISO, FIXTURE_NOW_MS, FIXTURE_TOKEN, minutesAgo } from "./fixture-runs.ts";

const PLAIN_REPO = "docs-site";
const LEGACY_AGENT = "legacy-reviewer";
const FAILED_REASON: RunFailureReason = "timed_out";
const HISTORY_COUNT = 18;

/** The ids contract. Every value is a fixed literal across boots. */
export interface FixtureIds {
	readonly projects: {
		/** Registered with `hasSeeds: true`; its clone carries `.seeds/`. */
		readonly withSeeds: { readonly id: string; readonly name: string };
		readonly withoutSeeds: { readonly id: string; readonly name: string };
	};
	/** One run per lifecycle state in `RUN_STATES`, plus a succeeded run with an open PR. */
	readonly runs: { readonly [K in RunState | "prOpen"]: string };
	readonly failedRunReason: RunFailureReason;
	readonly planRun: {
		readonly id: string;
		readonly planId: string;
		readonly children: readonly {
			readonly seq: number;
			readonly seedId: string;
			readonly state: string;
			readonly runId: string | null;
		}[];
	};
	/** Plans the fixture `sd` stub serves: the walked one and one still ready to dispatch. */
	readonly tracker: { readonly dispatchedPlanId: string; readonly readyPlanId: string };
	readonly agents: { readonly builtin: readonly string[]; readonly legacyLibrary: string };
	readonly events: { readonly runId: string; readonly count: number };
	/** Terminal runs spread over the last 14 days that feed every Telemetry tab. */
	readonly telemetry: { readonly historyRunIds: readonly string[]; readonly judgeRows: number };
}

/** Everything the boot needs back from the seeder. */
export interface SeedResult {
	readonly ids: FixtureIds;
	/** NDJSON body the fake judge export serves (newest first). */
	readonly judgeRuns: readonly { readonly runId: string; readonly endedAt: string }[];
}

const RUN_IDS = {
	queued: fxId("run", 101),
	running: fxId("run", 102),
	succeeded: fxId("run", 103),
	failed: fxId("run", 104),
	cancelled: fxId("run", 105),
	prOpen: fxId("run", 106),
} as const;

/** The six lifecycle-state runs on the seeds project. */
function stateRunSpecs(projectId: string): RunSpec[] {
	const base = { projectId, trigger: "manual" } as const;
	return [
		{
			...base,
			id: RUN_IDS.queued,
			agent: "claude-code",
			createdMin: 2,
			prompt: "Add a dark-mode toggle to the instance page header",
		},
		{
			...base,
			id: RUN_IDS.running,
			agent: "claude-code",
			seedId: "ah-fx-102",
			createdMin: 9,
			startedMin: 8,
			costUsd: 0.62,
			prompt: "Fix the runs table gutter so it no longer overflows at 393px",
		},
		{
			...base,
			id: RUN_IDS.succeeded,
			agent: "pi",
			createdMin: 95,
			startedMin: 94,
			endedMin: 71,
			terminal: "succeeded",
			costUsd: 1.18,
			filesChanged: 0,
			prompt: "Audit the telemetry copy for implementation notes (report only)",
		},
		{
			...base,
			id: RUN_IDS.failed,
			agent: "claude-code",
			seedId: "ah-fx-104",
			createdMin: 180,
			startedMin: 178,
			endedMin: 118,
			terminal: "failed",
			failureReason: FAILED_REASON,
			costUsd: 3.41,
			prompt: "Migrate the plan-runs table to the card primitive",
		},
		{
			...base,
			id: RUN_IDS.cancelled,
			agent: "pi",
			createdMin: 240,
			startedMin: 239,
			endedMin: 232,
			terminal: "cancelled",
			costUsd: 0.21,
			prompt: "Rename the operations page services panel",
		},
		{
			...base,
			id: RUN_IDS.prOpen,
			agent: "claude-code",
			seedId: "ah-fx-106",
			createdMin: 52,
			startedMin: 51,
			endedMin: 33,
			terminal: "succeeded",
			costUsd: 1.94,
			filesChanged: 4,
			prNumber: 1406,
			prState: "open",
			prompt: "Telemetry deep links survive on phone widths",
		},
	];
}

/** Plan-run children: one per non-transient child state, walked legally. */
const PLAN_CHILDREN = [
	{ seq: 1, state: "merged", run: 201 },
	{ seq: 2, state: "merged", run: 202 },
	{ seq: 3, state: "failed", run: 203 },
	{ seq: 4, state: "pr_open", run: 204 },
	{ seq: 5, state: "running", run: 205 },
	{ seq: 6, state: "pending", run: null },
	{ seq: 7, state: "skipped", run: null },
] as const;

const CHILD_PATH: Record<string, readonly PlanRunChildState[]> = {
	merged: ["dispatched", "running", "pr_open", "merged"],
	failed: ["dispatched", "running", "failed"],
	pr_open: ["dispatched", "running", "pr_open"],
	running: ["dispatched", "running"],
	pending: [],
	skipped: ["skipped"],
};

const PLAN_ID = "pl-fx01";
/** The plan-run started 10h ago; children stagger 80 minutes apart. */
const PLAN_T0_MIN = 600;
type ChildPatch = Parameters<Repos["planRuns"]["updateChild"]>[0]["patch"];
type PlanChild = FixtureIds["planRun"]["children"][number];

function childStartedMin(seq: number): number {
	return PLAN_T0_MIN - (seq - 1) * 80;
}

/** The linked run for one plan-run child: terminal unless the child is live. */
function planChildRunSpec(c: PlanChild, runId: string, projectId: string): RunSpec {
	const startedMin = childStartedMin(c.seq);
	const spec: RunSpec = {
		id: runId,
		projectId,
		agent: "claude-code",
		trigger: "plan-run",
		seedId: c.seedId,
		prompt: `Plan ${PLAN_ID} step ${c.seq}: implement ${c.seedId}`,
		createdMin: startedMin + 1,
		startedMin,
		costUsd: 0.8 + c.seq * 0.35,
	};
	if (c.state === "running") return spec;
	const ended = { ...spec, endedMin: startedMin - 55 };
	if (c.state === "failed")
		return { ...ended, terminal: "failed", failureReason: "provider_error" };
	const prState = c.state === "merged" ? "merged" : "open";
	return {
		...ended,
		terminal: "succeeded",
		filesChanged: c.seq + 1,
		prNumber: 1390 + c.seq,
		prState,
	};
}

/** The patch for one hop of a child's legal walk (`CHILD_PATH`). */
function childPatch(c: PlanChild, state: PlanRunChildState, step: number): ChildPatch {
	const startedMin = childStartedMin(c.seq);
	const settledAt = minutesAgo(startedMin - 70).toISOString();
	const patch: ChildPatch = { state };
	if (step === 0 && c.runId !== null) {
		Object.assign(patch, { runId: c.runId, startedAt: minutesAgo(startedMin).toISOString() });
	}
	if (state === "merged") Object.assign(patch, { endedAt: settledAt, prMergedAt: settledAt });
	if (state === "failed") {
		Object.assign(patch, {
			endedAt: settledAt,
			failureReason: "linked run failed: provider_error",
		});
	}
	return patch;
}

async function seedPlanRun(repos: Repos, projectId: string): Promise<FixtureIds["planRun"]> {
	const id = fxId("plnr", 1);
	const children: PlanChild[] = PLAN_CHILDREN.map((c) => ({
		seq: c.seq,
		seedId: `ah-fx-2${c.seq}`,
		state: c.state,
		runId: c.run !== null ? fxId("run", c.run) : null,
	}));
	for (const c of children) {
		if (c.runId !== null) await seedRun(repos, planChildRunSpec(c, c.runId, projectId));
	}
	await repos.planRuns.create({
		id,
		planId: PLAN_ID,
		projectId,
		agentName: "claude-code",
		trigger: "manual",
		children: children.map((c) => ({ seq: c.seq, seedId: c.seedId })),
		now: minutesAgo(PLAN_T0_MIN + 2),
	});
	await repos.planRuns.transitionTo(id, "running", {
		startedAt: minutesAgo(PLAN_T0_MIN + 1).toISOString(),
	});
	for (const c of children) {
		for (const [step, state] of (CHILD_PATH[c.state] ?? []).entries()) {
			await repos.planRuns.updateChild({
				planRunId: id,
				seq: c.seq,
				patch: childPatch(c, state, step),
				now: minutesAgo(childStartedMin(c.seq) - step * 15),
			});
		}
	}
	return { id, planId: PLAN_ID, children };
}

const HISTORY_OUTCOMES = [
	"merged",
	"merged",
	"failed",
	"merged",
	"closed",
	"merged",
	"cancelled",
	"merged",
	"nochange",
] as const;
const HISTORY_FAILURES: readonly RunFailureReason[] = [
	"provider_error",
	"timed_out",
	"dropped_commit",
];
const HISTORY_TRIGGERS = ["manual", "cli", "plan-run", "cron"] as const;

/** History run `i`: a deterministic spread over 14 days and a mix of outcomes. */
function historySpec(i: number, projectId: string): RunSpec & { readonly endedMin: number } {
	const outcome = HISTORY_OUTCOMES[i % HISTORY_OUTCOMES.length] ?? "merged";
	const startedMin = Math.round(((i * 13) % 14) * (DAY_MS / MINUTE_MS) + 120 + ((i * 47) % 300));
	const spec = {
		id: fxId("run", 301 + i),
		projectId,
		agent: i % 3 === 2 ? "pi" : "claude-code",
		trigger: HISTORY_TRIGGERS[i % HISTORY_TRIGGERS.length] ?? "manual",
		seedId: `ah-fx-3${String(i).padStart(2, "0")}`,
		prompt: `History run ${i + 1}: tidy telemetry panel ${i % 5}`,
		createdMin: startedMin + 1 + (i % 4),
		startedMin,
		endedMin: startedMin - (6 + ((i * 7) % 25)),
		terminal: "succeeded",
		costUsd: Math.round((0.35 + ((i * 37) % 100) / 38) * 100) / 100,
		filesChanged: outcome === "nochange" ? 0 : 1 + (i % 6),
	} as const;
	if (outcome === "failed") {
		const failureReason = HISTORY_FAILURES[i % HISTORY_FAILURES.length] ?? "crashed";
		return { ...spec, terminal: "failed", failureReason };
	}
	if (outcome === "cancelled") return { ...spec, terminal: "cancelled" };
	if (outcome === "nochange") return spec;
	const prState = outcome === "merged" ? "merged" : "closed_unmerged";
	return { ...spec, prNumber: 1300 + i, prState };
}

/** Terminal history runs over the last 14 days, with transcripts and tool calls. */
async function seedHistory(
	repos: Repos,
	projects: readonly string[],
): Promise<{ ids: string[]; judgeRuns: { runId: string; endedAt: string }[] }> {
	const ids: string[] = [];
	const judgeRuns: { runId: string; endedAt: string }[] = [];
	for (let i = 0; i < HISTORY_COUNT; i++) {
		const spec = historySpec(i, projects[i % projects.length] ?? "");
		await seedRun(repos, spec);
		const endedAt = minutesAgo(spec.endedMin);
		await appendWithToolCalls(
			repos,
			historyRunEvents({
				runId: spec.id,
				index: i,
				startedMs: minutesAgo(spec.startedMin ?? spec.endedMin).getTime(),
				endedMs: endedAt.getTime(),
				prUrl: spec.prNumber !== undefined ? prUrlFor(spec.prNumber) : null,
				steered: i % 5 === 1,
			}),
		);
		ids.push(spec.id);
		if (spec.terminal !== "cancelled") {
			judgeRuns.push({ runId: spec.id, endedAt: endedAt.toISOString() });
		}
	}
	return { ids, judgeRuns };
}

export interface SeedFixtureInput {
	/** The sqlite file warren will boot against (`<tmpRoot>/data/warren.db`). */
	readonly dbPath: string;
	/** Clone dirs the two project rows point at (created if missing). */
	readonly seedsProjectPath: string;
	readonly plainProjectPath: string;
}

/** Seed the whole fixture into a fresh database and return the ids contract. */
export async function seedFixtureDb(input: SeedFixtureInput): Promise<SeedResult> {
	await mkdir(input.plainProjectPath, { recursive: true });
	await mkdir(join(input.dbPath, ".."), { recursive: true });
	const db = await openDatabase({ path: input.dbPath });
	try {
		const repos = createRepos(db);
		const registeredAt = new Date(FIXTURE_NOW_MS - 21 * DAY_MS);
		const seedsProject = await repos.projects.create({
			id: fxId("prj", 1),
			gitUrl: `https://github.com/${OWNER}/${SEEDS_REPO}.git`,
			localPath: input.seedsProjectPath,
			defaultBranch: "main",
			hasSeeds: true,
			now: registeredAt,
		});
		const plainProject = await repos.projects.create({
			id: fxId("prj", 2),
			gitUrl: `https://github.com/${OWNER}/${PLAIN_REPO}.git`,
			localPath: input.plainProjectPath,
			defaultBranch: "main",
			hasSeeds: false,
			now: registeredAt,
		});
		// A pre-pl-3a79 canopy library row: no `source: builtin` stamp, so
		// `GET /agents` reports it as `source: "library"`.
		const base = AGENT_JSON.get("claude-code");
		if (base === undefined) throw new Error("fixture-data: claude-code builtin missing");
		await repos.agents.upsert({
			name: LEGACY_AGENT,
			renderedJson: {
				...stampAgentSource({ ...base, name: LEGACY_AGENT }, "library"),
				resolvedFrom: ["canopy:legacy-reviewer@3"],
			},
			now: registeredAt,
		});

		for (const spec of stateRunSpecs(seedsProject.id)) await seedRun(repos, spec);
		const eventCount = await appendWithToolCalls(
			repos,
			runningRunEvents(RUN_IDS.running, minutesAgo(8).getTime()),
		);
		const planRun = await seedPlanRun(repos, seedsProject.id);
		const history = await seedHistory(repos, [seedsProject.id, plainProject.id]);

		const ids: FixtureIds = {
			projects: {
				withSeeds: { id: seedsProject.id, name: `${OWNER}/${SEEDS_REPO}` },
				withoutSeeds: { id: plainProject.id, name: `${OWNER}/${PLAIN_REPO}` },
			},
			runs: RUN_IDS,
			failedRunReason: FAILED_REASON,
			planRun,
			tracker: { dispatchedPlanId: planRun.planId, readyPlanId: "pl-fx02" },
			agents: { builtin: BUILTIN_AGENTS.map((a) => a.name), legacyLibrary: LEGACY_AGENT },
			events: { runId: RUN_IDS.running, count: eventCount },
			telemetry: { historyRunIds: history.ids, judgeRows: history.judgeRuns.length },
		};
		return { ids, judgeRuns: history.judgeRuns };
	} finally {
		await db.close();
	}
}
