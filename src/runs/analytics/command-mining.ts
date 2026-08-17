/**
 * Command-mining aggregator (warren-8976 / pl-ad0f step 7).
 *
 * Pure, dialect-agnostic companion to `run-metrics.ts`. Takes a flat list of
 * tool-call trace rows — the `tool_use` / `tool_result` events
 * {@link EventsRepo.listToolEventsForRuns} returns across an analytics window —
 * and mines the shell commands agents actually ran into a ranked behaviour
 * report for the `GET /analytics/behavior` endpoint (step 9):
 *
 *   - `byFrequency`: generalized commands ranked by invocation count
 *   - `byFailures`: same commands ranked by failure count
 *   - `byStuckScore`: the "stuck-command leaderboard" — commands the agent kept
 *     re-running after they had already failed in the same run, ranked by how
 *     often that re-run failed again (the strongest "agent is stuck in a loop"
 *     signal)
 *   - `osEcoCommands`: os-eco tooling (`ml` / `sd` / `gh` / `bun run check:*`)
 *     ranked by frequency, so the dashboard can highlight how much of a run is
 *     spent driving warren's own workflow
 *   - `byCategory`: invocation/failure rollup per command category, for the
 *     command-category bar chart (step 10)
 *
 * "Generalization" collapses a raw command string to a stable signature — the
 * binary plus (for multi-subcommand CLIs like `git`/`gh`/`sd`/`ml`/`bun`) its
 * first subcommand — so `bun run check:all` and `bun check:all` rank together
 * and per-invocation arguments don't fragment the ranking. Only rows carrying
 * a command are mined; structured tool calls (Read/Edit/etc.) are counted in
 * `totals.toolUses` but contribute no command rows.
 *
 * Payload reading already happened at extraction time through the per-runtime
 * shape registries (`src/core/tool-shape.ts`, warren-c116): each row carries
 * its run's runtime id plus the shape-extracted fields, so the report can
 * still tell "this harness emitted no commands" (no shape declared, or every
 * call was a non-command tool) apart from "commands did not parse" per
 * runtime (`totals.byRuntime`). A row whose runtime shape could not read the
 * source payload at all lands with `toolName`/`command`/`toolUseId` all null
 * — the registry's exact parse-failure condition — and counts as unparsed.
 *
 * Failure correlation is pre-joined in the rollup: the tool_result's
 * `is_error` was folded onto its tool_use row at extraction time, and a
 * tool_use whose result never arrived reads as non-error. A "retry" is an invocation of a command that had
 * already failed earlier in the same run; "stuckScore" counts the retries that
 * failed again. Both are computed in run-local seq order, so a tight
 * fail→retry→fail loop scores higher than scattered one-off failures.
 *
 * Determinism: every ranking is sorted by its primary metric descending with
 * ties broken by a secondary metric then the command string ascending, so
 * golden/unit tests are stable regardless of input row order.
 */

import { toolShapeFor } from "../../core/tool-shape.ts";
import type { RuntimeId } from "../../core/wire.ts";
import {
	type CommandCategory,
	categorize,
	generalizeCommand,
	isOsEcoCommand,
} from "./command-generalize.ts";

// Re-export the generalization vocabulary so existing import sites
// (`src/runs/index.ts`, tests) keep working after the file split.
export {
	type CommandCategory,
	categorize,
	generalizeCommand,
	isOsEcoCommand,
} from "./command-generalize.ts";

/**
 * One structured tool-call row (warren-7746): a `tool_calls` rollup row
 * plus its run's runtime id, resolved by the handler from the rendered
 * agent frontmatter. All shape reading happened at extraction time — the
 * fields here are the extraction's output, not a payload to re-parse.
 */
export interface ToolCallMiningRow {
	readonly runId: string;
	/** sandbox_event_seq of the tool_use event — orders calls within a run. */
	readonly seq: number;
	/** The invoked tool's name, or null when the shape read none. */
	readonly toolName: string | null;
	/** The shell command for Bash-class calls, or null for structured tools. */
	readonly command: string | null;
	/** The id the tool_result joined back on, or null. */
	readonly toolUseId: string | null;
	/** The tool_result's error flag, pre-joined at extraction time. */
	readonly isError: boolean;
	/** UTF-8 byte size of the result body, or null when absent/unjoined. */
	readonly resultBytes: number | null;
	/**
	 * The run's runtime id (warren-c116). Drives the per-runtime coverage
	 * rollup's `shaped` flag; `null` marks a row whose runtime could not be
	 * attributed.
	 */
	readonly runtime: RuntimeId | null;
}

export interface CommandStat {
	/** generalized signature, e.g. `"bun test"` or `"bun run check:all"`. */
	readonly command: string;
	readonly category: CommandCategory;
	/** os-eco tooling (`ml`/`sd`/`gh`/`bun run check:*`) — highlight in the UI. */
	readonly osEco: boolean;
	/** distinct runs that invoked the command. */
	readonly runs: number;
	readonly invocations: number;
	readonly failures: number;
	/** failures / invocations, or null when there were no invocations. */
	readonly failureRate: number | null;
	/** invocations that re-ran a command already failed earlier in the same run. */
	readonly retries: number;
	/** retries that failed again — the "stuck in a loop" signal. */
	readonly stuckScore: number;
}

export interface CategoryBucket {
	readonly category: CommandCategory;
	readonly invocations: number;
	readonly failures: number;
	/** distinct generalized commands in the category. */
	readonly commands: number;
}

/**
 * Per-runtime parse coverage (warren-c116): how many `tool_use` rows a
 * runtime produced, how many yielded a command, and how many the
 * runtime's declared tool shape could not read at all. This is what
 * lets `/analytics/behavior` distinguish "the harness emitted no
 * commands" (`shaped: false` — no tool shape is declared for the
 * runtime; or every call was a non-command tool) from
 * "commands did not parse" (`unparsed > 0`).
 */
export interface RuntimeCommandCoverage {
	/** the runtime id, or `"unknown"` for unattributed rows. */
	readonly runtime: RuntimeId | "unknown";
	/** whether a tool shape is declared for this runtime. */
	readonly shaped: boolean;
	/** `tool_use` rows seen for this runtime. */
	readonly toolUses: number;
	/** `tool_use` rows that yielded a generalized command. */
	readonly commands: number;
	/** `tool_use` rows whose shape read returned null (parse failures). */
	readonly unparsed: number;
}

export interface CommandMiningTotals {
	/** all `tool_use` rows seen (command-bearing or not). */
	readonly toolUses: number;
	/** `tool_use` rows we parsed a command from. */
	readonly commands: number;
	readonly distinctCommands: number;
	readonly failures: number;
	readonly retries: number;
	/** per-runtime parse coverage, sorted by runtime id ascending. */
	readonly byRuntime: readonly RuntimeCommandCoverage[];
}

export interface CommandMining {
	readonly totals: CommandMiningTotals;
	readonly byFrequency: readonly CommandStat[];
	readonly byFailures: readonly CommandStat[];
	/** stuck-command leaderboard — only commands with at least one retry. */
	readonly byStuckScore: readonly CommandStat[];
	readonly osEcoCommands: readonly CommandStat[];
	readonly byCategory: readonly CategoryBucket[];
}

/** Resolve a row's runtime's declared tool shape (coverage `shaped` flag). */
function shapeForRow(row: ToolCallMiningRow) {
	return row.runtime === null ? null : toolShapeFor(row.runtime);
}

interface StatAcc {
	command: string;
	category: CommandCategory;
	osEco: boolean;
	runs: Set<string>;
	invocations: number;
	failures: number;
	retries: number;
	stuckScore: number;
}

function getStat(acc: Map<string, StatAcc>, command: string): StatAcc {
	let stat = acc.get(command);
	if (stat === undefined) {
		stat = {
			command,
			category: categorize(command),
			osEco: isOsEcoCommand(command),
			runs: new Set(),
			invocations: 0,
			failures: 0,
			retries: 0,
			stuckScore: 0,
		};
		acc.set(command, stat);
	}
	return stat;
}

interface UseEntry {
	command: string;
	isError: boolean;
}

function groupByRun(rows: readonly ToolCallMiningRow[]): Map<string, ToolCallMiningRow[]> {
	const grouped = new Map<string, ToolCallMiningRow[]>();
	for (const r of rows) {
		let g = grouped.get(r.runId);
		if (g === undefined) {
			g = [];
			grouped.set(r.runId, g);
		}
		g.push(r);
	}
	return grouped;
}

/**
 * True when the extraction could not read the source payload at all — the
 * shape registry's exact parse-failure condition (all three fields null).
 */
function isUnparsed(row: ToolCallMiningRow): boolean {
	return row.toolName === null && row.command === null && row.toolUseId === null;
}

/** Parse outcome for one rollup row, for the per-runtime coverage rollup. */
type UseParse =
	| { readonly outcome: "entry"; readonly entry: UseEntry }
	| { readonly outcome: "no-command" } // parsed, but a non-command tool
	| { readonly outcome: "unparsed" }; // the shape could not read the payload

/** Resolve a rollup row to a UseEntry; is_error is pre-joined. */
function parseUse(row: ToolCallMiningRow): UseParse {
	if (isUnparsed(row)) return { outcome: "unparsed" };
	if (row.command === null) return { outcome: "no-command" };
	const command = generalizeCommand(row.command);
	if (command === null) return { outcome: "no-command" };
	return { outcome: "entry", entry: { command, isError: row.isError } };
}

interface CoverageAcc {
	runtime: RuntimeId | "unknown";
	shaped: boolean;
	toolUses: number;
	commands: number;
	unparsed: number;
}

function coverageFor(acc: Map<string, CoverageAcc>, row: ToolCallMiningRow): CoverageAcc {
	const runtime = row.runtime ?? "unknown";
	let cov = acc.get(runtime);
	if (cov === undefined) {
		cov = {
			runtime,
			shaped: shapeForRow(row) !== null,
			toolUses: 0,
			commands: 0,
			unparsed: 0,
		};
		acc.set(runtime, cov);
	}
	return cov;
}

/** Group rows by run; within a run, resolve each command-bearing call. */
function entriesByRun(rows: readonly ToolCallMiningRow[]): {
	byRun: Map<string, UseEntry[]>;
	toolUses: number;
	coverage: RuntimeCommandCoverage[];
} {
	let toolUses = 0;
	const coverageAcc = new Map<string, CoverageAcc>();
	const byRun = new Map<string, UseEntry[]>();
	for (const [runId, runRows] of groupByRun(rows)) {
		const sorted = [...runRows].sort((a, b) => a.seq - b.seq);
		const entries: UseEntry[] = [];
		for (const r of sorted) {
			toolUses += 1;
			const cov = coverageFor(coverageAcc, r);
			cov.toolUses += 1;
			const parsed = parseUse(r);
			if (parsed.outcome === "entry") {
				cov.commands += 1;
				entries.push(parsed.entry);
			} else if (parsed.outcome === "unparsed") {
				cov.unparsed += 1;
			}
		}
		byRun.set(runId, entries);
	}
	const coverage = [...coverageAcc.values()].sort((a, b) =>
		a.runtime < b.runtime ? -1 : a.runtime > b.runtime ? 1 : 0,
	);
	return { byRun, toolUses, coverage };
}

function accumulateRun(
	acc: Map<string, StatAcc>,
	runId: string,
	entries: readonly UseEntry[],
): void {
	const failedBefore = new Set<string>();
	for (const e of entries) {
		const stat = getStat(acc, e.command);
		stat.invocations += 1;
		stat.runs.add(runId);
		if (e.isError) stat.failures += 1;
		if (failedBefore.has(e.command)) {
			stat.retries += 1;
			if (e.isError) stat.stuckScore += 1;
		}
		if (e.isError) failedBefore.add(e.command);
	}
}

function accumulate(acc: Map<string, StatAcc>, byRun: Map<string, UseEntry[]>): void {
	for (const [runId, entries] of byRun) accumulateRun(acc, runId, entries);
}

function finalize(stat: StatAcc): CommandStat {
	return {
		command: stat.command,
		category: stat.category,
		osEco: stat.osEco,
		runs: stat.runs.size,
		invocations: stat.invocations,
		failures: stat.failures,
		failureRate: stat.invocations === 0 ? null : stat.failures / stat.invocations,
		retries: stat.retries,
		stuckScore: stat.stuckScore,
	};
}

function byCommandAsc(a: CommandStat, b: CommandStat): number {
	return a.command < b.command ? -1 : a.command > b.command ? 1 : 0;
}

function rankBy(
	stats: readonly CommandStat[],
	primary: (s: CommandStat) => number,
	secondary: (s: CommandStat) => number,
): CommandStat[] {
	return [...stats].sort((a, b) => {
		if (primary(b) !== primary(a)) return primary(b) - primary(a);
		if (secondary(b) !== secondary(a)) return secondary(b) - secondary(a);
		return byCommandAsc(a, b);
	});
}

function buildCategories(stats: readonly CommandStat[]): CategoryBucket[] {
	const acc = new Map<
		CommandCategory,
		{ invocations: number; failures: number; commands: number }
	>();
	for (const s of stats) {
		let c = acc.get(s.category);
		if (c === undefined) {
			c = { invocations: 0, failures: 0, commands: 0 };
			acc.set(s.category, c);
		}
		c.invocations += s.invocations;
		c.failures += s.failures;
		c.commands += 1;
	}
	const out: CategoryBucket[] = [];
	for (const [category, c] of acc) out.push({ category, ...c });
	out.sort((a, b) => {
		if (b.invocations !== a.invocations) return b.invocations - a.invocations;
		return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
	});
	return out;
}

/**
 * Build the full command-mining report from structured tool-call `rows`.
 * O(rows) — a group-by-run pass plus a handful of sorts over the
 * distinct-command set.
 */
export function buildCommandMining(rows: readonly ToolCallMiningRow[]): CommandMining {
	const { byRun, toolUses, coverage } = entriesByRun(rows);
	const acc = new Map<string, StatAcc>();
	accumulate(acc, byRun);
	const stats: CommandStat[] = [];
	for (const stat of acc.values()) stats.push(finalize(stat));

	let commands = 0;
	let failures = 0;
	let retries = 0;
	for (const s of stats) {
		commands += s.invocations;
		failures += s.failures;
		retries += s.retries;
	}

	return {
		totals: {
			toolUses,
			commands,
			distinctCommands: stats.length,
			failures,
			retries,
			byRuntime: coverage,
		},
		byFrequency: rankBy(
			stats,
			(s) => s.invocations,
			(s) => s.failures,
		),
		byFailures: rankBy(
			stats,
			(s) => s.failures,
			(s) => s.invocations,
		),
		byStuckScore: rankBy(
			stats.filter((s) => s.retries > 0),
			(s) => s.stuckScore,
			(s) => s.retries,
		),
		osEcoCommands: rankBy(
			stats.filter((s) => s.osEco),
			(s) => s.invocations,
			(s) => s.failures,
		),
		byCategory: buildCategories(stats),
	};
}
