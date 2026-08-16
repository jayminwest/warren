import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import {
	buildCommandMining,
	type CommandStat,
	categorize,
	generalizeCommand,
	isOsEcoCommand,
	type ToolCallMiningRow,
} from "./command-mining.ts";

let seq = 0;

/** A command-bearing (Bash-class) rollup row. */
function call(
	runId: string,
	command: string,
	opts: { id?: string; isError?: boolean; runtime?: RuntimeId | null } = {},
): ToolCallMiningRow {
	seq += 1;
	return {
		runId,
		seq,
		toolName: "Bash",
		command,
		toolUseId: opts.id ?? null,
		isError: opts.isError ?? false,
		resultBytes: null,
		runtime: opts.runtime === undefined ? "claude-code" : opts.runtime,
	};
}

/** A structured (non-command) rollup row, e.g. a Read call. */
function structured(runId: string, runtime: RuntimeId | null = "claude-code"): ToolCallMiningRow {
	seq += 1;
	return {
		runId,
		seq,
		toolName: "Read",
		command: null,
		toolUseId: "t9",
		isError: false,
		resultBytes: null,
		runtime,
	};
}

/**
 * A row whose runtime shape could not read the source payload at all —
 * the all-null extraction (warren-7746).
 */
function unparsed(runId: string, runtime: RuntimeId | null): ToolCallMiningRow {
	seq += 1;
	return {
		runId,
		seq,
		toolName: null,
		command: null,
		toolUseId: null,
		isError: false,
		resultBytes: null,
		runtime,
	};
}

function statFor(stats: readonly CommandStat[], command: string): CommandStat {
	const found = stats.find((s) => s.command === command);
	if (found === undefined) throw new Error(`no stat for ${command}`);
	return found;
}

describe("generalizeCommand", () => {
	test("returns the bare binary for single-token commands", () => {
		expect(generalizeCommand("ls")).toBe("ls");
		expect(generalizeCommand("  pwd  ")).toBe("pwd");
	});

	test("keeps the first subcommand for multi-subcommand CLIs", () => {
		expect(generalizeCommand("git commit -m 'wip'")).toBe("git commit");
		expect(generalizeCommand("gh pr create --fill")).toBe("gh pr");
		expect(generalizeCommand("sd close warren-1 warren-2")).toBe("sd close");
		expect(generalizeCommand("ml record --domain build x")).toBe("ml record");
	});

	test("collapses bun and bun-run script forms to one signature", () => {
		expect(generalizeCommand("bun run check:all")).toBe("bun run check:all");
		expect(generalizeCommand("bun check:all")).toBe("bun run check:all");
		expect(generalizeCommand("bun test")).toBe("bun test");
		expect(generalizeCommand("bun run test src/x.test.ts")).toBe("bun test");
	});

	test("keeps bun subcommands distinct from run scripts", () => {
		expect(generalizeCommand("bun install")).toBe("bun install");
		expect(generalizeCommand("bun i")).toBe("bun i");
		expect(generalizeCommand("bun add lodash")).toBe("bun add");
		expect(generalizeCommand("bun remove lodash")).toBe("bun remove");
		expect(generalizeCommand("bun x prettier")).toBe("bun x");
		expect(generalizeCommand("bun pm ls")).toBe("bun pm");
		expect(generalizeCommand("bun build ./index.ts")).toBe("bun build");
	});

	test("uses the trailing &&-joined segment", () => {
		expect(generalizeCommand("cd /workspace && bun test")).toBe("bun test");
		expect(generalizeCommand("cd a && cd b && git status")).toBe("git status");
	});

	test("strips leading sudo and env-var assignments", () => {
		expect(generalizeCommand("sudo rm -rf /tmp/x")).toBe("rm");
		expect(generalizeCommand("FOO=1 BAR=2 bun test")).toBe("bun test");
	});

	test("returns null for empty or whitespace-only commands", () => {
		expect(generalizeCommand("")).toBeNull();
		expect(generalizeCommand("   ")).toBeNull();
	});
});

describe("isOsEcoCommand", () => {
	test("flags ml/sd/gh and bun-run check scripts", () => {
		expect(isOsEcoCommand("ml record")).toBe(true);
		expect(isOsEcoCommand("sd close")).toBe(true);
		expect(isOsEcoCommand("gh pr")).toBe(true);
		expect(isOsEcoCommand("bun run check:all")).toBe(true);
		expect(isOsEcoCommand("bun run check:coverage")).toBe(true);
	});

	test("does not flag ordinary tooling", () => {
		expect(isOsEcoCommand("git commit")).toBe(false);
		expect(isOsEcoCommand("bun test")).toBe(false);
		expect(isOsEcoCommand("ls")).toBe(false);
	});
});

describe("categorize", () => {
	test("maps commands to their category", () => {
		expect(categorize("sd close")).toBe("os-eco");
		expect(categorize("git status")).toBe("vcs");
		expect(categorize("bun install")).toBe("package");
		expect(categorize("bun test")).toBe("test");
		expect(categorize("bun run build")).toBe("build");
		expect(categorize("tsc")).toBe("build");
		expect(categorize("grep")).toBe("filesystem");
		expect(categorize("curl")).toBe("network");
		expect(categorize("python")).toBe("other");
	});

	test("uses token-precise matching so script names are not misclassified", () => {
		expect(categorize(generalizeCommand("bun run latest") ?? "")).toBe("other");
		expect(categorize(generalizeCommand("bun run rebuild") ?? "")).toBe("other");
	});

	test("buckets colon-namespaced scripts by their matching segment", () => {
		expect(categorize(generalizeCommand("bun run test:unit") ?? "")).toBe("test");
		expect(categorize(generalizeCommand("bun run build:ui") ?? "")).toBe("build");
		// Direct (already-generalized) colon scripts also bucket by segment.
		expect(categorize("bun run lint:test")).toBe("test");
		// Non-matching colon scripts still fall through to `other`.
		expect(categorize(generalizeCommand("bun run latest:tag") ?? "")).toBe("other");
		expect(categorize(generalizeCommand("bun run prebuild:assets") ?? "")).toBe("other");
	});
});

describe("buildCommandMining", () => {
	test("counts tool calls including structured (non-command) tool calls", () => {
		const rows: ToolCallMiningRow[] = [call("r1", "bun test"), structured("r1")];
		const out = buildCommandMining(rows);
		expect(out.totals.toolUses).toBe(2);
		expect(out.totals.commands).toBe(1);
		expect(out.totals.distinctCommands).toBe(1);
	});

	test("reads failures from the pre-joined is_error flag", () => {
		const rows: ToolCallMiningRow[] = [
			call("r1", "bun test", { id: "t1", isError: true }),
			call("r1", "git status", { id: "t2" }),
		];
		const out = buildCommandMining(rows);
		expect(statFor(out.byFrequency, "bun test").failures).toBe(1);
		expect(statFor(out.byFrequency, "git status").failures).toBe(0);
		expect(out.totals.failures).toBe(1);
	});

	test("treats a call whose result never arrived as non-error", () => {
		const out = buildCommandMining([call("r1", "bun test", { id: "t1" })]);
		expect(statFor(out.byFrequency, "bun test").failures).toBe(0);
		expect(statFor(out.byFrequency, "bun test").failureRate).toBe(0);
	});

	test("scores retries and stuck loops within a run", () => {
		// bun test fails, re-run fails again, third re-run passes.
		const rows: ToolCallMiningRow[] = [
			call("r1", "bun test", { id: "a", isError: true }),
			call("r1", "bun test", { id: "b", isError: true }),
			call("r1", "bun test", { id: "c" }),
		];
		const stat = statFor(buildCommandMining(rows).byStuckScore, "bun test");
		expect(stat.invocations).toBe(3);
		expect(stat.failures).toBe(2);
		// 2 retries (b, c re-ran an already-failed command); stuckScore 1 (b failed again).
		expect(stat.retries).toBe(2);
		expect(stat.stuckScore).toBe(1);
	});

	test("does not count a re-run as a retry when no prior run failed", () => {
		const rows: ToolCallMiningRow[] = [
			call("r1", "ls", { id: "a" }),
			call("r1", "ls", { id: "b" }),
		];
		const stat = statFor(buildCommandMining(rows).byFrequency, "ls");
		expect(stat.invocations).toBe(2);
		expect(stat.retries).toBe(0);
		expect(stat.stuckScore).toBe(0);
	});

	test("retry tracking is scoped per run", () => {
		const rows: ToolCallMiningRow[] = [
			call("r1", "bun test", { id: "a", isError: true }),
			call("r2", "bun test", { id: "b", isError: true }),
		];
		const out = buildCommandMining(rows);
		const stat = statFor(out.byFrequency, "bun test");
		expect(stat.runs).toBe(2);
		expect(stat.retries).toBe(0); // first (and only) invocation in each run
		expect(out.byStuckScore).toHaveLength(0);
	});

	test("byStuckScore excludes commands with no retries", () => {
		const rows: ToolCallMiningRow[] = [call("r1", "git status", { id: "a", isError: true })];
		expect(buildCommandMining(rows).byStuckScore).toHaveLength(0);
	});

	test("ranks frequency, failures, and os-eco deterministically", () => {
		const rows: ToolCallMiningRow[] = [
			call("r1", "ls"),
			call("r1", "ls"),
			call("r1", "ls"),
			call("r1", "git status", { id: "g", isError: true }),
			call("r1", "sd close"),
			call("r1", "ml record"),
		];
		const out = buildCommandMining(rows);
		expect(out.byFrequency[0]?.command).toBe("ls");
		expect(out.byFrequency[0]?.invocations).toBe(3);
		expect(out.byFailures[0]?.command).toBe("git status");
		// os-eco list holds only ml/sd/gh, ranked by frequency then command asc.
		expect(out.osEcoCommands.map((s) => s.command)).toEqual(["ml record", "sd close"]);
		expect(out.osEcoCommands.every((s) => s.osEco)).toBe(true);
	});

	test("rolls invocations and failures up by category", () => {
		const rows: ToolCallMiningRow[] = [
			call("r1", "git status", { id: "a", isError: true }),
			call("r1", "git commit"),
			call("r1", "bun run check:all"),
		];
		const out = buildCommandMining(rows);
		const vcs = out.byCategory.find((c) => c.category === "vcs");
		expect(vcs).toEqual({ category: "vcs", invocations: 2, failures: 1, commands: 2 });
		const osEco = out.byCategory.find((c) => c.category === "os-eco");
		expect(osEco?.invocations).toBe(1);
	});

	test("counts all-null (unparsed) rows in the per-runtime coverage rollup", () => {
		const rows: ToolCallMiningRow[] = [
			unparsed("r1", "pi"),
			unparsed("r1", "pi"),
			unparsed("r1", "pi"),
		];
		const out = buildCommandMining(rows);
		expect(out.totals.toolUses).toBe(3);
		expect(out.totals.commands).toBe(0);
		expect(out.byFrequency).toHaveLength(0);
		expect(out.totals.byRuntime).toEqual([
			{ runtime: "pi", shaped: true, toolUses: 3, commands: 0, unparsed: 3 },
		]);
	});

	test("distinguishes parsed non-command tools from unparsed rows", () => {
		const rows: ToolCallMiningRow[] = [structured("r1", "pi"), unparsed("r1", "pi")];
		const out = buildCommandMining(rows);
		expect(out.totals.byRuntime).toEqual([
			{ runtime: "pi", shaped: true, toolUses: 2, commands: 0, unparsed: 1 },
		]);
	});

	test("marks rows of an unattributed runtime as not-shaped in the coverage rollup", () => {
		const rows: ToolCallMiningRow[] = [unparsed("r2", null)];
		const out = buildCommandMining(rows);
		expect(out.totals.commands).toBe(0);
		expect(out.totals.byRuntime).toEqual([
			{ runtime: "unknown", shaped: false, toolUses: 1, commands: 0, unparsed: 1 },
		]);
	});

	test("empty input yields an empty report", () => {
		const out = buildCommandMining([]);
		expect(out.totals).toEqual({
			toolUses: 0,
			commands: 0,
			distinctCommands: 0,
			failures: 0,
			retries: 0,
			byRuntime: [],
		});
		expect(out.byFrequency).toHaveLength(0);
		expect(out.byCategory).toHaveLength(0);
	});
});
