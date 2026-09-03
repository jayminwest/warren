/**
 * Stage-timestamp writers for the `runs` table (warren-7116), extracted from
 * `runs.ts` to hold that file under its 500-line budget — the same pattern as
 * `runs-workspace.ts` / `runs-pr.ts`: a free function taking the
 * `DrizzleAdapter`, with a thin `RunsRepo` delegate.
 *
 * The four columns decompose the run wall clock into its observed edges:
 * `workspace_ready_at` (workspace prepared / init container done),
 * `agent_ready_at` (first event — claimed), `agent_ended_at`
 * (runtime-terminal detected, before reap), `reaped_at` (transitioned
 * terminal). Every writer is first-write-wins so a re-run pass (bridge
 * reconnect, reap retry, pod resync) never overwrites the original
 * observation; each is also a no-op for rows predating the column, which
 * stay null = "unknown".
 */

import { and, eq, isNull } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

async function stampWhenNull(
	adapter: DrizzleAdapter,
	id: string,
	column: "workspaceReadyAt" | "agentReadyAt" | "agentEndedAt" | "reapedAt",
	at: Date,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(
		db
			.update(runs)
			.set({ [column]: at.toISOString() })
			.where(and(eq(runs.id, id), isNull(runs[column]))),
	);
}

/** Stamp `workspace_ready_at` — the workspace-init edge. First write wins. */
export function markWorkspaceReady(adapter: DrizzleAdapter, id: string, at: Date): Promise<void> {
	return stampWhenNull(adapter, id, "workspaceReadyAt", at);
}

/** Stamp `agent_ended_at` — the runtime-terminal edge. First write wins. */
export function markAgentEnded(adapter: DrizzleAdapter, id: string, at: Date): Promise<void> {
	return stampWhenNull(adapter, id, "agentEndedAt", at);
}

/** Stamp `reaped_at` — the reap-complete edge. First write wins. */
export function markReaped(adapter: DrizzleAdapter, id: string, at: Date): Promise<void> {
	return stampWhenNull(adapter, id, "reapedAt", at);
}
