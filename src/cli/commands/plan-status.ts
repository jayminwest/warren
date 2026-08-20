/**
 * `warren plan status <id>` / `warren plan list` — read-only HTTP-client
 * commands that round out the `plan` family (warren-5e3f, pl-55df step 4).
 *
 * Both are one-shot GETs (no event tailing): `status` renders a single
 * plan-run's child-state table with per-child cost + duration pulled from the
 * fanned-out `runs[]` rows, while `list` prints the plan-run index, optionally
 * filtered by `--project` / `--state`. Like the rest of the `plan` group they
 * talk to a remote warren via `resolveCommandClient`, probe first so a
 * down server is a friendly stderr line rather than a mid-call throw, and
 * default to NDJSON output (pipeline parity) with an opt-in `--output pretty`
 * human renderer.
 */

import type { WarrenClient } from "../../client/index.ts";
import type {
	PlanRunChildRow,
	PlanRunDetailResponse,
	PlanRunRow,
	PlanRunState,
	RunRow,
} from "../../client/types.ts";
import type { CliContext } from "../output.ts";
import {
	commandFailure,
	EXIT_SERVER_UNREACHABLE,
	exitCodeForError,
	formatError,
	type WriteSink,
	writeJsonLine,
} from "../output.ts";
import type { PlanRunOutput } from "../plan-run-renderer.ts";
import { runCost, runDuration } from "../run-renderer.ts";
import { columnWidths, formatRow, renderTable } from "../table.ts";
import { guardRemotePlanRun, probeOrReport } from "./probe.ts";

export interface PlanStatusArgs {
	readonly planRunId: string;
	readonly output?: PlanRunOutput;
}

export interface PlanListArgs {
	readonly project?: string;
	readonly state?: PlanRunState;
	readonly output?: PlanRunOutput;
}

export interface PlanStatusDeps {
	readonly client: WarrenClient;
	readonly probeTimeoutMs?: number;
}

export type PlanListDeps = PlanStatusDeps;

export interface PlanStatusResult {
	readonly exitCode: number;
	readonly planRunId?: string;
	readonly state?: PlanRunState;
}

export interface PlanListResult {
	readonly exitCode: number;
	readonly count?: number;
}

export async function runPlanStatus(
	context: CliContext,
	deps: PlanStatusDeps,
	args: PlanStatusArgs,
): Promise<PlanStatusResult> {
	const guard = await guardRemotePlanRun(context, deps.client, args.planRunId, deps.probeTimeoutMs);
	if (guard !== null) return guard;
	try {
		const detail = await deps.client.getPlanRun(args.planRunId);
		if ((args.output ?? "ndjson") === "pretty") {
			renderStatusPretty(context.stdio.stdout, detail);
		} else {
			writeJsonLine(context.stdio.stdout, detail);
		}
		return { exitCode: 0, planRunId: detail.planRun.id, state: detail.planRun.state };
	} catch (err) {
		return { ...commandFailure(context, err), planRunId: args.planRunId };
	}
}

export async function runPlanList(
	context: CliContext,
	deps: PlanListDeps,
	args: PlanListArgs,
): Promise<PlanListResult> {
	if (!(await probeOrReport(context, deps.client, deps.probeTimeoutMs))) {
		return { exitCode: EXIT_SERVER_UNREACHABLE };
	}
	try {
		const filter = {
			...(args.project !== undefined ? { project: args.project } : {}),
			...(args.state !== undefined ? { state: args.state } : {}),
		};
		const { planRuns } = await deps.client.listPlanRuns(filter);
		if ((args.output ?? "ndjson") === "pretty") {
			renderListPretty(context.stdio.stdout, planRuns);
		} else {
			for (const planRun of planRuns) {
				writeJsonLine(context.stdio.stdout, planRun);
			}
		}
		return { exitCode: 0, count: planRuns.length };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: exitCodeForError(err) };
	}
}

/** Pretty renderer for `plan status`: header + per-child cost/duration table. */
function renderStatusPretty(sink: WriteSink, detail: PlanRunDetailResponse): void {
	const { planRun, children, runs } = detail;
	const line = (text: string): void => sink.write(`${text}\n`);
	line(
		`plan-run ${planRun.id} [${planRun.state}] — plan ${planRun.planId}, ` +
			`agent ${planRun.agentName}, ${children.length} ` +
			`${children.length === 1 ? "child" : "children"}`,
	);
	if (planRun.failureReason !== null && planRun.failureReason !== "") {
		line(`  failure: ${planRun.failureReason}`);
	}
	if (children.length === 0) {
		line("  (no children)");
		return;
	}
	const runById = new Map<string, RunRow>(runs.map((run) => [run.id, run]));
	const rows = children.map((child) => childRow(child, runById));
	const widths = columnWidths(rows);
	line(`  ${formatRow(HEADER, widths)}`);
	for (const row of rows) {
		line(`  ${formatRow(row, widths)}`);
	}
}

/** Column headers for the child-state table. */
const HEADER: readonly string[] = ["#", "seed", "state", "cost", "duration", "run"];

/** Build one table row (string cells) for a child + its optional run row. */
function childRow(child: PlanRunChildRow, runById: Map<string, RunRow>): readonly string[] {
	const run = child.runId !== null ? (runById.get(child.runId) ?? null) : null;
	return [
		`#${child.seq}`,
		child.seedId,
		child.state,
		runCost(run?.costUsd ?? null),
		runDuration(run),
		child.runId ?? "—",
	];
}

/** Pretty renderer for `plan list`: one aligned line per plan-run. */
function renderListPretty(sink: WriteSink, planRuns: readonly PlanRunRow[]): void {
	const line = (text: string): void => sink.write(`${text}\n`);
	if (planRuns.length === 0) {
		line("(no plan-runs)");
		return;
	}
	const header = ["id", "state", "plan", "project", "agent", "created"];
	const rows = planRuns.map((pr) => [
		pr.id,
		pr.state,
		pr.planId ?? "-",
		pr.projectId,
		pr.agentName,
		pr.createdAt,
	]);
	renderTable(sink, header, rows);
}
