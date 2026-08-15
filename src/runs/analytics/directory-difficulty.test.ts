import { describe, expect, test } from "bun:test";
import {
	buildDirectoryDifficulty,
	type DirectoryRunOutcome,
	type DirectoryToolCallRow,
	MIN_DIRECTORY_RUNS,
	normalizeDirectory,
} from "./directory-difficulty.ts";

describe("normalizeDirectory", () => {
	test("maps a file path to its parent directory", () => {
		expect(normalizeDirectory("src/server/handlers/analytics.ts", "Read")).toBe(
			"src/server/handlers",
		);
	});

	test("strips leading ./ segments", () => {
		expect(normalizeDirectory("./src/foo.ts", "Edit")).toBe("src");
	});

	test("aggregates a bare filename under the workspace root", () => {
		expect(normalizeDirectory("README.md", "Write")).toBe(".");
	});

	test("treats a directory-scoped tool path as the directory itself", () => {
		expect(normalizeDirectory("src/server", "Grep")).toBe("src/server");
		expect(normalizeDirectory("src/server/", "Glob")).toBe("src/server");
	});

	test("keeps an absolute file path's parent", () => {
		expect(normalizeDirectory("/workspace/src/foo.ts", "Read")).toBe("/workspace/src");
	});

	test("returns null for paths with no directory signal", () => {
		expect(normalizeDirectory("", "Read")).toBeNull();
		expect(normalizeDirectory("/", "LS")).toBeNull();
	});
});

function row(
	runId: string,
	seq: number,
	paths: readonly string[],
	isError = false,
	toolName: string | null = "Read",
): DirectoryToolCallRow {
	return { runId, seq, toolName, isError, filePaths: paths };
}

function outcome(runId: string, state: string): DirectoryRunOutcome {
	return { runId, state };
}

describe("buildDirectoryDifficulty", () => {
	test("returns an empty rollup with window denominators when no rows carry paths", () => {
		const result = buildDirectoryDifficulty(
			[row("r1", 1, [], false)],
			[outcome("r1", "succeeded"), outcome("r2", "failed")],
			new Map(),
		);
		expect(result.directories).toEqual([]);
		// r2 predates the rollup (no rows): in the window denominator,
		// excluded from the known subset.
		expect(result.totals).toEqual({
			runsInWindow: 2,
			runsWithFilePaths: 0,
			fileTouches: 0,
			directoriesRanked: 0,
			directoriesBelowMinN: 0,
		});
	});

	test("withholds directories under the minimum-N guard", () => {
		const rows = [row("r1", 1, ["src/a.ts"]), row("r2", 1, ["src/a.ts"], true)];
		const result = buildDirectoryDifficulty(
			rows,
			[outcome("r1", "succeeded"), outcome("r2", "failed")],
			new Map(),
		);
		expect(result.directories).toEqual([]);
		expect(result.totals.directoriesBelowMinN).toBe(1);
		expect(result.totals.runsWithFilePaths).toBe(2);
	});

	test("aggregates failures, retries, and steering per directory with denominators", () => {
		const runs = ["r1", "r2", "r3", "r4"];
		const rows = [
			// r1: clean read in src/server.
			row("r1", 1, ["src/server/x.ts"]),
			// r2: an errored edit, then a retry of the same path (in seq order).
			row("r2", 1, ["src/server/y.ts"], true, "Edit"),
			row("r2", 2, ["src/server/y.ts"], false, "Edit"),
			// r3: touches both src/server and docs.
			row("r3", 1, ["src/server/z.ts"]),
			row("r3", 2, ["docs/guide.md"]),
			// r4: a retry that fails again, in a run that itself fails.
			row("r4", 1, ["src/server/x.ts"], true),
			row("r4", 2, ["src/server/x.ts"], true),
		];
		const steering = new Map([
			["r2", 1],
			["r4", 2],
		]);
		const result = buildDirectoryDifficulty(
			rows,
			[
				outcome("r1", "succeeded"),
				outcome("r2", "failed"),
				outcome("r3", "succeeded"),
				outcome("r4", "failed"),
			],
			steering,
		);
		// docs has one run touching it — withheld by the minimum-N guard.
		expect(result.directories).toHaveLength(1);
		const server = result.directories[0];
		expect(server?.directory).toBe("src/server");
		expect(server?.runsTouching).toBe(4);
		expect(server?.runsFailed).toBe(2);
		expect(server?.failureShare).toBe(0.5);
		expect(server?.fileTouches).toBe(6);
		expect(server?.errorTouches).toBe(3);
		expect(server?.retries).toBe(2);
		expect(server?.steeringMessages).toBe(3);
		expect(server?.confidence).toBe("low");
		expect(server?.difficultyScore).toBeCloseTo(0.5 + 2 / 6);
		expect(result.totals.directoriesBelowMinN).toBe(1);
		expect(result.totals.runsWithFilePaths).toBe(4);
		expect(runs).toHaveLength(4);
	});

	test("a retry only counts when the earlier same-path call errored in the same run", () => {
		const mkRows = (runId: string) => [
			row(runId, 1, ["src/a.ts"], true),
			row(runId, 2, ["src/a.ts"], false),
		];
		const rows = ["r1", "r2", "r3"].flatMap(mkRows);
		const result = buildDirectoryDifficulty(
			rows,
			[outcome("r1", "succeeded"), outcome("r2", "succeeded"), outcome("r3", "succeeded")],
			new Map(),
		);
		const stat = result.directories[0];
		expect(stat?.directory).toBe("src");
		expect(stat?.retries).toBe(3);
		expect(stat?.runsFailed).toBe(0);
		expect(stat?.failureShare).toBe(0);
	});

	test("confidence rises with the runs-touching denominator", () => {
		const runIds = Array.from({ length: 10 }, (_, i) => `r${i}`);
		const rows = runIds.map((id, i) => row(id, 1, [`src/f${i}.ts`]));
		const five = buildDirectoryDifficulty(
			rows.slice(0, 5),
			runIds.slice(0, 5).map((id) => outcome(id, "succeeded")),
			new Map(),
		);
		expect(five.directories[0]?.confidence).toBe("medium");
		const ten = buildDirectoryDifficulty(
			rows,
			runIds.map((id) => outcome(id, "succeeded")),
			new Map(),
		);
		expect(ten.directories[0]?.confidence).toBe("high");
	});

	test("ranks top-N by evidence volume with deterministic ties", () => {
		const runIds = ["r1", "r2", "r3"];
		const rows = [
			...runIds.map((id) => row(id, 1, ["b/x.ts"])),
			...runIds.map((id) => row(id, 2, ["b/y.ts"])),
			...runIds.map((id) => row(id, 1, ["a/x.ts"])),
			...runIds.map((id) => row(id, 2, ["c/x.ts"])),
		];
		const result = buildDirectoryDifficulty(
			rows,
			runIds.map((id) => outcome(id, "succeeded")),
			new Map(),
			{ limit: 2 },
		);
		expect(result.directories.map((d) => d.directory)).toEqual(["b", "a"]);
		expect(result.totals.directoriesRanked).toBe(2);
		expect(MIN_DIRECTORY_RUNS).toBe(3);
	});
});
