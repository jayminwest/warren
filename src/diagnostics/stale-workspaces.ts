/**
 * `stale_sandbox_workspaces` diagnostic for `warren doctor` / `GET /readyz`
 * (warren-0a9a). Reports burrow workspaces whose runs are all terminal and
 * whose newest activity is older than the fallback workspace-GC TTL.
 *
 * Reuses the GC's `findStrandedBurrows` predicate so the report and the
 * sweeper agree on what "stranded" means. Since the `burrows` placement table
 * was dropped (warren-3743), the candidate set is derived entirely from the
 * `runs` table. An informational `ok: true` when nothing is stranded; warns
 * (with a recovery hint) when the GC has work pending — so an operator who
 * disabled the worker still has a visible signal that disk is leaking.
 */

import type { RunRow, RunState } from "../db/schema.ts";
import {
	buildBurrowActivity,
	findStrandedBurrows,
	GC_ACTIVE_RUN_STATES,
	GC_TERMINAL_RUN_STATES,
} from "../runs/reap/gc.ts";
import type { DiagnosticCheck, DiagnosticLogger } from "./checks.ts";
import { dbFailureMessage } from "./redact.ts";

export interface StaleBurrowWorkspaceProbe {
	listByState(state: RunState[]): Promise<RunRow[]>;
}

export async function checkStaleSandboxWorkspaces(deps: {
	readonly probe: StaleBurrowWorkspaceProbe;
	readonly ttlMs: number;
	readonly now?: Date;
	/** Sink for the raw driver text the message deliberately withholds (warren-51de). */
	readonly log?: DiagnosticLogger;
}): Promise<DiagnosticCheck> {
	let activeRuns: RunRow[];
	let terminalRuns: RunRow[];
	try {
		[activeRuns, terminalRuns] = await Promise.all([
			deps.probe.listByState([...GC_ACTIVE_RUN_STATES]),
			deps.probe.listByState([...GC_TERMINAL_RUN_STATES]),
		]);
	} catch (err) {
		return {
			name: "stale_sandbox_workspaces",
			ok: false,
			message: dbFailureMessage("stale_sandbox_workspaces", err, deps.log),
			hint: "verify the database is reachable and the runs table exists",
		};
	}
	const activity = buildBurrowActivity(activeRuns, terminalRuns);
	let tracked = 0;
	for (const sandboxId of activity.latestEndedAt.keys()) {
		if (!activity.activeBurrowIds.has(sandboxId)) tracked += 1;
	}
	const stranded = findStrandedBurrows({
		...activity,
		ttlMs: deps.ttlMs,
		now: deps.now ?? new Date(),
	});
	if (stranded.length === 0) {
		return {
			name: "stale_sandbox_workspaces",
			ok: true,
			message: `${tracked} tracked burrow workspace${tracked === 1 ? "" : "s"}, none stranded`,
		};
	}
	return {
		name: "stale_sandbox_workspaces",
		ok: false,
		message: `${stranded.length} stranded burrow workspace${stranded.length === 1 ? "" : "s"} (terminal runs older than the GC TTL)`,
		hint: "the fallback workspace GC reclaims these on its next sweep; if WARREN_WORKSPACE_GC_DISABLED is set, re-enable it or destroy the burrows manually via burrow",
	};
}
