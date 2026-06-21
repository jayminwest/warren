/**
 * `warren plan status <id>` / `warren plan list` — read-only HTTP-client
 * commands that round out the `plan` family (warren-5e3f, pl-55df step 4).
 *
 * Both are one-shot GETs (no event tailing): `status` renders a single
 * plan-run's child-state table with per-child cost + duration pulled from the
 * fanned-out `runs[]` rows, while `list` prints the plan-run index, optionally
 * filtered by `--project` / `--state`. Like the rest of the `plan` group they
 * talk to a remote warren via {@link WarrenClient.fromEnv}, probe first so a
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
import { formatError, type WriteSink, writeJsonLine } from "../output.ts";
import type { PlanRunOutput } from "../plan-run-renderer.ts";

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

/** Probe the remote warren, mapping an unreachable server to a stderr line. */
async function probeOrReport(deps: PlanStatusDeps, context: CliContext): Promise<boolean> {
	try {
		await (deps.probeTimeoutMs !== undefined
			? deps.client.probe(deps.probeTimeoutMs)
			: deps.client.probe());
		return true;
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return false;
	}
}

export async function runPlanStatus(
	context: CliContext,
	deps: PlanStatusDeps,
	args: PlanStatusArgs,
): Promise<PlanStatusResult> {
	if (args.planRunId === "") {
		context.stdio.stderr.write("warren: plan-run id is required\n");
		return { exitCode: 2 };
	}
	if (!(await probeOrReport(deps, context))) {
		return { exitCode: 1 };
	}
	try {
		const detail = await deps.client.getPlanRun(args.planRunId);
		if ((args.output ?? "ndjson") === "pretty") {
			renderStatusPretty(context.stdio.stdout, detail);
		} else {
			writeJsonLine(context.stdio.stdout, detail);
		}
		return { exitCode: 0, planRunId: detail.planRun.id, state: detail.planRun.state };
	} catch (err) {
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1, planRunId: args.planRunId };
	}
}

export async function runPlanList(
	context: CliContext,
	deps: PlanListDeps,
	args: PlanListArgs,
): Promise<PlanListResult> {
	if (!(await probeOrReport(deps, context))) {
		return { exitCode: 1 };
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
		return { exitCode: 1 };
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
	const run = child.runId !== null ? runById.get(child.runId) : undefined;
	return [
		`#${child.seq}`,
		child.seedId,
		child.state,
		formatCost(run?.costUsd ?? null),
		formatDuration(run ?? null),
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
		pr.planId,
		pr.projectId,
		pr.agentName,
		pr.createdAt,
	]);
	const widths = columnWidths([header, ...rows]);
	line(formatRow(header, widths));
	for (const row of rows) {
		line(formatRow(row, widths));
	}
}

/** Compute the max width of each column across all rows. */
function columnWidths(rows: readonly (readonly string[])[]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	return widths;
}

/** Left-pad each cell to its column width and join with two spaces. */
function formatRow(row: readonly string[], widths: readonly number[]): string {
	return row
		.map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
		.join("  ")
		.trimEnd();
}

/** Render a cost in USD, or an em-dash when unknown. */
function formatCost(costUsd: number | null): string {
	return costUsd === null ? "—" : `$${costUsd.toFixed(4)}`;
}

/** Render a run's wall-clock duration as `Ns`, or an em-dash when unknown. */
function formatDuration(run: RunRow | null): string {
	if (run === null || run.startedAt === null || run.endedAt === null) return "—";
	const started = Date.parse(run.startedAt);
	const ended = Date.parse(run.endedAt);
	if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return "—";
	return `${((ended - started) / 1000).toFixed(1)}s`;
}
