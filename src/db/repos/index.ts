/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Higher layers grab one Repos and pass it through.
 */

import type { AnyWarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { ConversationsRepo } from "./conversations.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { MessagesRepo } from "./messages.ts";
import { PlanRunsRepo } from "./plan-runs.ts";
import { PlotsRepo } from "./plots.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunInboxRepo } from "./run-inbox.ts";
import { RunsRepo } from "./runs.ts";
import { TriggersRepo } from "./triggers.ts";

export interface Repos {
	agents: AgentsRepo;
	projects: ProjectsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	triggers: TriggersRepo;
	planRuns: PlanRunsRepo;
	plots: PlotsRepo;
	conversations: ConversationsRepo;
	messages: MessagesRepo;
	runInbox: RunInboxRepo;
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
		plots: new PlotsRepo(adapter),
		conversations: new ConversationsRepo(adapter),
		messages: new MessagesRepo(adapter),
		runInbox: new RunInboxRepo(adapter),
	};
}

export {
	AgentsRepo,
	ConversationsRepo,
	EventsRepo,
	MessagesRepo,
	PlanRunsRepo,
	PlotsRepo,
	ProjectsRepo,
	RunInboxRepo,
	RunsRepo,
	TriggersRepo,
};
