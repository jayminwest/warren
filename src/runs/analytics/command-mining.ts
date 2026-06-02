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
 * and per-invocation arguments don't fragment the ranking. Only `tool_use`
 * rows that actually carry a command (`payload.input.command` or
 * `payload.command`) are mined; structured tool calls (Read/Edit/etc.) are
 * counted in `totals.toolUses` but contribute no command rows.
 *
 * Failure correlation joins each `tool_result` back to its `tool_use` via
 * `tool_use_id` (per run); a tool_use with no matching result, or no id, is
 * treated as non-error. A "retry" is an invocation of a command that had
 * already failed earlier in the same run; "stuckScore" counts the retries that
 * failed again. Both are computed in run-local seq order, so a tight
 * fail→retry→fail loop scores higher than scattered one-off failures.
 *
 * Determinism: every ranking is sorted by its primary metric descending with
 * ties broken by a secondary metric then the command string ascending, so
 * golden/unit tests are stable regardless of input row order.
 */

/** One tool-call trace row, mapped from an `events` row by the handler. */
export interface ToolEventRow {
	readonly runId: string;
	/** `"tool_use"` | `"tool_result"` (other kinds are ignored). */
	readonly kind: string;
	/** burrow_event_seq — orders events within a run. */
	readonly seq: number;
	/** the raw `payload_json`, parsed defensively. */
	readonly payload: unknown;
}

export type CommandCategory =
	| "os-eco"
	| "vcs"
	| "package"
	| "build"
	| "test"
	| "filesystem"
	| "network"
	| "other";

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

export interface CommandMiningTotals {
	/** all `tool_use` rows seen (command-bearing or not). */
	readonly toolUses: number;
	/** `tool_use` rows we parsed a command from. */
	readonly commands: number;
	readonly distinctCommands: number;
	readonly failures: number;
	readonly retries: number;
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

/** CLIs whose first subcommand is part of the generalized signature. */
const MULTI_SUBCOMMAND = new Set([
	"git",
	"gh",
	"sd",
	"ml",
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"docker",
	"kubectl",
	"go",
]);
const FS_BINS = new Set([
	"cat",
	"ls",
	"grep",
	"rg",
	"find",
	"sed",
	"awk",
	"head",
	"tail",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"touch",
	"echo",
	"chmod",
	"wc",
	"sort",
	"uniq",
	"tee",
	"cd",
	"pwd",
	"tree",
	"stat",
	"diff",
]);
const NET_BINS = new Set(["curl", "wget", "ping", "ssh", "scp", "nc", "dig"]);
const PKG_SUBS = new Set(["install", "add", "remove", "ci", "uninstall", "update"]);
const PKG_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Collapse a raw command string to a stable signature, or null when it carries
 * no runnable binary. `cd x && bun test` → `bun test` (the trailing `&&`
 * segment); leading `sudo` / `VAR=val` prefixes and flags are stripped.
 */
export function generalizeCommand(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	// Use the last &&-joined segment so `cd dir && bun test` mines `bun test`.
	const segments = trimmed
		.split("&&")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	const segment = segments[segments.length - 1] ?? trimmed;
	const tokens = segment.split(/\s+/).filter((t) => t !== "");
	let i = 0;
	while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i] ?? "") || tokens[i] === "sudo")) {
		i += 1;
	}
	const binToken = tokens[i];
	if (binToken === undefined) return null;
	const base = basename(binToken);
	if (base === "") return null;
	if (!MULTI_SUBCOMMAND.has(base)) return base;
	const rest = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
	if (base === "bun") return generalizeBun(rest);
	const sub = rest[0];
	return sub === undefined ? base : `${base} ${sub}`;
}

/**
 * Bun's own subcommands, which must not be collapsed into the
 * `bun run <script>` family — `bun install` is package management, not a
 * user script named `install`. `run` and `test` are handled separately.
 */
const BUN_SUBCOMMANDS = new Set(
	"install i add a remove rm update outdated link unlink pm x create init build upgrade publish patch audit why exec repl".split(
		" ",
	),
);

/**
 * `bun` / `bun run` normalize to the same `bun run <script>` family, but bun's
 * own subcommands (`bun install`, `bun add`, …) keep their `bun <sub>` shape
 * rather than masquerading as a run script.
 */
function generalizeBun(rest: readonly string[]): string {
	const first = rest[0];
	if (first === undefined) return "bun";
	if (first !== "run" && first !== "test" && BUN_SUBCOMMANDS.has(first)) {
		return `bun ${first}`;
	}
	const args = first === "run" ? rest.slice(1) : rest;
	const script = args[0];
	if (script === undefined) return "bun";
	if (script === "test") return "bun test";
	return `bun run ${script}`;
}

export function isOsEcoCommand(generalized: string): boolean {
	const bin = generalized.split(" ")[0] ?? "";
	if (bin === "ml" || bin === "sd" || bin === "gh") return true;
	return generalized.startsWith("bun run check:");
}

// True when any token's `:`-delimited segments exactly match `segment`, so
// `test:unit`/`lint:test` match `test` while `latest` does not (warren-1f19).
function hasSegment(parts: readonly string[], segment: string): boolean {
	return parts.some((part) => part.split(":").includes(segment));
}

export function categorize(generalized: string): CommandCategory {
	if (isOsEcoCommand(generalized)) return "os-eco";
	const parts = generalized.split(" ");
	const bin = parts[0] ?? "";
	if (bin === "git") return "vcs";
	if (PKG_MANAGERS.has(bin)) {
		// Token- and segment-precise matching: `latest`/`rebuild` must not match
		// `test`/`build` (warren-d4d5), while colon-namespaced scripts like
		// `test:unit`/`build:ui` bucket by their matching segment (warren-1f19).
		if (hasSegment(parts, "test")) return "test";
		if (PKG_SUBS.has(parts[1] ?? "")) return "package";
		if (hasSegment(parts, "build")) return "build";
		return "other";
	}
	if (["tsc", "vite", "make", "cargo", "tsup", "esbuild", "webpack"].includes(bin)) return "build";
	if (["vitest", "jest", "mocha", "pytest"].includes(bin)) return "test";
	if (FS_BINS.has(bin)) return "filesystem";
	if (NET_BINS.has(bin)) return "network";
	return "other";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Extract the command string from a `tool_use` payload, or null. */
function commandOf(payload: unknown): string | null {
	const obj = asRecord(payload);
	if (obj === null) return null;
	const input = asRecord(obj.input);
	const fromInput = input?.command;
	if (typeof fromInput === "string") return fromInput;
	return typeof obj.command === "string" ? obj.command : null;
}

function toolUseIdOf(payload: unknown): string | null {
	const obj = asRecord(payload);
	if (obj === null) return null;
	const id = obj.tool_use_id ?? obj.id;
	return typeof id === "string" ? id : null;
}

function isErrorOf(payload: unknown): boolean {
	const obj = asRecord(payload);
	if (obj === null) return false;
	const flag = obj.is_error ?? obj.isError;
	return flag === true;
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

function groupByRun(rows: readonly ToolEventRow[]): Map<string, ToolEventRow[]> {
	const grouped = new Map<string, ToolEventRow[]>();
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

/** tool_use_id → is_error for every tool_result row in a run. */
function resultMap(sorted: readonly ToolEventRow[]): Map<string, boolean> {
	const results = new Map<string, boolean>();
	for (const r of sorted) {
		if (r.kind !== "tool_result") continue;
		const id = toolUseIdOf(r.payload);
		if (id !== null) results.set(id, isErrorOf(r.payload));
	}
	return results;
}

/** Resolve a command-bearing tool_use row to a UseEntry, or null to skip it. */
function toEntry(row: ToolEventRow, results: Map<string, boolean>): UseEntry | null {
	const raw = commandOf(row.payload);
	if (raw === null) return null;
	const command = generalizeCommand(raw);
	if (command === null) return null;
	const id = toolUseIdOf(row.payload);
	return { command, isError: id !== null && (results.get(id) ?? false) };
}

/** Group rows by run; within a run, resolve each command-bearing tool_use. */
function entriesByRun(rows: readonly ToolEventRow[]): {
	byRun: Map<string, UseEntry[]>;
	toolUses: number;
} {
	let toolUses = 0;
	const byRun = new Map<string, UseEntry[]>();
	for (const [runId, runRows] of groupByRun(rows)) {
		const sorted = [...runRows].sort((a, b) => a.seq - b.seq);
		const results = resultMap(sorted);
		const entries: UseEntry[] = [];
		for (const r of sorted) {
			if (r.kind !== "tool_use") continue;
			toolUses += 1;
			const entry = toEntry(r, results);
			if (entry !== null) entries.push(entry);
		}
		byRun.set(runId, entries);
	}
	return { byRun, toolUses };
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
 * Build the full command-mining report from tool-call trace `rows`. O(rows) —
 * a group-by-run pass plus a handful of sorts over the distinct-command set.
 */
export function buildCommandMining(rows: readonly ToolEventRow[]): CommandMining {
	const { byRun, toolUses } = entriesByRun(rows);
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
