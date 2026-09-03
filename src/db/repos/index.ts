/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Higher layers grab one Repos and pass it through.
 */

import type { AnyWarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { DispatchContextRepo } from "./dispatch-context.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { PlanRunsRepo } from "./plan-runs.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunInboxRepo } from "./run-inbox.ts";
import { RunsRepo } from "./runs.ts";
import { ToolCallsRepo } from "./tool-calls.ts";
import { TriggersRepo } from "./triggers.ts";

export interface Repos {
	agents: AgentsRepo;
	projects: ProjectsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	triggers: TriggersRepo;
	planRuns: PlanRunsRepo;
	runInbox: RunInboxRepo;
	toolCalls: ToolCallsRepo;
	dispatchContext: DispatchContextRepo;
}

export function createRepos(db: AnyWarrenDb): Repos {
	const adapter = DrizzleAdapter.for(db);
	return {
		agents: new AgentsRepo(adapter),
		projects: new ProjectsRepo(adapter),
		runs: new RunsRepo(adapter),
		events: new EventsRepo(adapter),
		triggers: new TriggersRepo(adapter),
		planRuns: new PlanRunsRepo(adapter),
		runInbox: new RunInboxRepo(adapter),
		toolCalls: new ToolCallsRepo(adapter),
		dispatchContext: new DispatchContextRepo(adapter),
	};
}

export type { DispatchFacts } from "./dispatch-context.ts";
export {
	AgentsRepo,
	DispatchContextRepo,
	EventsRepo,
	PlanRunsRepo,
	ProjectsRepo,
	RunInboxRepo,
	RunsRepo,
	ToolCallsRepo,
	TriggersRepo,
};
