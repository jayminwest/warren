import { describe, expect, test } from "bun:test";
import {
	buildCommandMining,
	type CommandStat,
	categorize,
	generalizeCommand,
	isOsEcoCommand,
	type ToolEventRow,
} from "./command-mining.ts";

let seq = 0;

function use(runId: string, command: string, id?: string): ToolEventRow {
	seq += 1;
	return {
		runId,
		kind: "tool_use",
		seq,
		payload: { tool: "bash", id, input: { command } },
	};
}

function result(runId: string, id: string, isError: boolean): ToolEventRow {
	seq += 1;
	return { runId, kind: "tool_result", seq, payload: { tool_use_id: id, is_error: isError } };
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
	test("counts tool_uses including structured (non-command) tool calls", () => {
		const rows: ToolEventRow[] = [
			use("r1", "bun test"),
			{ runId: "r1", kind: "tool_use", seq: 999, payload: { tool: "read", input: { path: "x" } } },
		];
		const out = buildCommandMining(rows);
		expect(out.totals.toolUses).toBe(2);
		expect(out.totals.commands).toBe(1);
		expect(out.totals.distinctCommands).toBe(1);
	});

	test("correlates tool_result.is_error to tool_use via tool_use_id", () => {
		const rows: ToolEventRow[] = [
			use("r1", "bun test", "t1"),
			result("r1", "t1", true),
			use("r1", "git status", "t2"),
			result("r1", "t2", false),
		];
		const out = buildCommandMining(rows);
		expect(statFor(out.byFrequency, "bun test").failures).toBe(1);
		expect(statFor(out.byFrequency, "git status").failures).toBe(0);
		expect(out.totals.failures).toBe(1);
	});

	test("treats a tool_use with no matching result as non-error", () => {
		const out = buildCommandMining([use("r1", "bun test", "t1")]);
		expect(statFor(out.byFrequency, "bun test").failures).toBe(0);
		expect(statFor(out.byFrequency, "bun test").failureRate).toBe(0);
	});

	test("scores retries and stuck loops within a run", () => {
		// bun test fails, re-run fails again, third re-run passes.
		const rows: ToolEventRow[] = [
			use("r1", "bun test", "a"),
			result("r1", "a", true),
			use("r1", "bun test", "b"),
			result("r1", "b", true),
			use("r1", "bun test", "c"),
			result("r1", "c", false),
		];
		const stat = statFor(buildCommandMining(rows).byStuckScore, "bun test");
		expect(stat.invocations).toBe(3);
		expect(stat.failures).toBe(2);
		// 2 retries (b, c re-ran an already-failed command); stuckScore 1 (b failed again).
		expect(stat.retries).toBe(2);
		expect(stat.stuckScore).toBe(1);
	});

	test("does not count a re-run as a retry when no prior run failed", () => {
		const rows: ToolEventRow[] = [
			use("r1", "ls", "a"),
			result("r1", "a", false),
			use("r1", "ls", "b"),
			result("r1", "b", false),
		];
		const stat = statFor(buildCommandMining(rows).byFrequency, "ls");
		expect(stat.invocations).toBe(2);
		expect(stat.retries).toBe(0);
		expect(stat.stuckScore).toBe(0);
	});

	test("retry tracking is scoped per run", () => {
		const rows: ToolEventRow[] = [
			use("r1", "bun test", "a"),
			result("r1", "a", true),
			use("r2", "bun test", "b"),
			result("r2", "b", true),
		];
		const out = buildCommandMining(rows);
		const stat = statFor(out.byFrequency, "bun test");
		expect(stat.runs).toBe(2);
		expect(stat.retries).toBe(0); // first (and only) invocation in each run
		expect(out.byStuckScore).toHaveLength(0);
	});

	test("byStuckScore excludes commands with no retries", () => {
		const rows: ToolEventRow[] = [use("r1", "git status", "a"), result("r1", "a", true)];
		expect(buildCommandMining(rows).byStuckScore).toHaveLength(0);
	});

	test("ranks frequency, failures, and os-eco deterministically", () => {
		const rows: ToolEventRow[] = [
			use("r1", "ls"),
			use("r1", "ls"),
			use("r1", "ls"),
			use("r1", "git status", "g"),
			result("r1", "g", true),
			use("r1", "sd close"),
			use("r1", "ml record"),
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
		const rows: ToolEventRow[] = [
			use("r1", "git status", "a"),
			result("r1", "a", true),
			use("r1", "git commit"),
			use("r1", "bun run check:all"),
		];
		const out = buildCommandMining(rows);
		const vcs = out.byCategory.find((c) => c.category === "vcs");
		expect(vcs).toEqual({ category: "vcs", invocations: 2, failures: 1, commands: 2 });
		const osEco = out.byCategory.find((c) => c.category === "os-eco");
		expect(osEco?.invocations).toBe(1);
	});

	test("ignores unparseable payloads without throwing", () => {
		const rows: ToolEventRow[] = [
			{ runId: "r1", kind: "tool_use", seq: 1, payload: null },
			{ runId: "r1", kind: "tool_use", seq: 2, payload: "garbage" },
			{ runId: "r1", kind: "tool_use", seq: 3, payload: { input: { command: "" } } },
		];
		const out = buildCommandMining(rows);
		expect(out.totals.toolUses).toBe(3);
		expect(out.totals.commands).toBe(0);
		expect(out.byFrequency).toHaveLength(0);
	});

	test("reads command from payload.command when input is absent", () => {
		const out = buildCommandMining([
			{ runId: "r1", kind: "tool_use", seq: 1, payload: { command: "bun test" } },
		]);
		expect(out.totals.commands).toBe(1);
		expect(out.byFrequency[0]?.command).toBe("bun test");
	});

	test("empty input yields an empty report", () => {
		const out = buildCommandMining([]);
		expect(out.totals).toEqual({
			toolUses: 0,
			commands: 0,
			distinctCommands: 0,
			failures: 0,
			retries: 0,
		});
		expect(out.byFrequency).toHaveLength(0);
		expect(out.byCategory).toHaveLength(0);
	});
});
