/**
 * `stale_burrow_workspaces` diagnostic for `warren doctor` / `GET /readyz`
 * (warren-0a9a). Reports burrow placement rows whose runs are all terminal
 * and whose newest activity is older than the fallback workspace-GC TTL.
 *
 * Reuses the GC's `findStrandedBurrows` predicate so the report and the
 * sweeper agree on what "stranded" means. An informational `ok: true` when
 * nothing is stranded; warns (with a recovery hint) when the GC has work
 * pending — so an operator who disabled the worker still has a visible
 * signal that disk is leaking.
 */

import type { BurrowRow, RunRow, RunState } from "../db/schema.ts";
import {
	buildBurrowActivity,
	findStrandedBurrows,
	GC_ACTIVE_RUN_STATES,
	GC_TERMINAL_RUN_STATES,
} from "../runs/reap/gc.ts";
import type { DiagnosticCheck } from "./checks.ts";

export interface StaleBurrowWorkspaceProbe {
	listAll(): Promise<BurrowRow[]>;
	listByState(state: RunState[]): Promise<RunRow[]>;
}

export async function checkStaleBurrowWorkspaces(deps: {
	readonly probe: StaleBurrowWorkspaceProbe;
	readonly ttlMs: number;
	readonly now?: Date;
}): Promise<DiagnosticCheck> {
	let burrows: BurrowRow[];
	let activeRuns: RunRow[];
	let terminalRuns: RunRow[];
	try {
		[burrows, activeRuns, terminalRuns] = await Promise.all([
			deps.probe.listAll(),
			deps.probe.listByState([...GC_ACTIVE_RUN_STATES]),
			deps.probe.listByState([...GC_TERMINAL_RUN_STATES]),
		]);
	} catch (err) {
		return {
			name: "stale_burrow_workspaces",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "verify the database is reachable and the burrows/runs tables exist",
		};
	}
	const stranded = findStrandedBurrows({
		burrows,
		...buildBurrowActivity(activeRuns, terminalRuns),
		ttlMs: deps.ttlMs,
		now: deps.now ?? new Date(),
	});
	if (stranded.length === 0) {
		return {
			name: "stale_burrow_workspaces",
			ok: true,
			message: `${burrows.length} tracked burrow workspace${burrows.length === 1 ? "" : "s"}, none stranded`,
		};
	}
	return {
		name: "stale_burrow_workspaces",
		ok: false,
		message: `${stranded.length} stranded burrow workspace${stranded.length === 1 ? "" : "s"} (terminal runs older than the GC TTL)`,
		hint: "the fallback workspace GC reclaims these on its next sweep; if WARREN_WORKSPACE_GC_DISABLED is set, re-enable it or destroy the burrows manually via burrow",
	};
}
