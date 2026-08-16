import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type CoverageBudgets,
	type CoverageTotals,
	checkBudgets,
	loadBudgets,
	parseAllFilesRow,
} from "./check-coverage.ts";

describe("loadBudgets", () => {
	test("parses valid percentages", () => {
		const b = loadBudgets(JSON.stringify({ functions: 85.5, lines: 90.25 }));
		expect(b).toEqual({ functions: 85.5, lines: 90.25 });
	});

	test("rejects out-of-range functions floor", () => {
		expect(() => loadBudgets(JSON.stringify({ functions: 120, lines: 90 }))).toThrow(/functions/);
	});

	test("rejects non-numeric lines floor", () => {
		expect(() => loadBudgets(JSON.stringify({ functions: 85, lines: "90" }))).toThrow(/lines/);
	});
});

describe("parseAllFilesRow", () => {
	test("extracts functions and lines from the Bun coverage table", () => {
		const output = [
			"--------------------------------------|---------|---------|-------------------",
			"File                                  | % Funcs | % Lines | Uncovered Line #s",
			"--------------------------------------|---------|---------|-------------------",
			" All files                            |   86.25 |   91.62 |",
			"--------------------------------------|---------|---------|-------------------",
		].join("\n");
		expect(parseAllFilesRow(output)).toEqual({ functions: 86.25, lines: 91.62 });
	});

	test("strips ANSI color codes before matching", () => {
		const colored =
			" All files                            |   \x1B[32m100.00\x1B[0m |   \x1B[32m99.50\x1B[0m |";
		expect(parseAllFilesRow(colored)).toEqual({ functions: 100, lines: 99.5 });
	});

	test("returns undefined when the row is missing", () => {
		expect(parseAllFilesRow("no coverage table here\n")).toBeUndefined();
	});
});

describe("checkBudgets", () => {
	const budgets: CoverageBudgets = { functions: 85, lines: 90 };

	test("returns no failures when both totals clear the floor", () => {
		const totals: CoverageTotals = { functions: 86.25, lines: 91.62 };
		expect(checkBudgets(totals, budgets)).toEqual([]);
	});

	test("flags functions below floor", () => {
		const totals: CoverageTotals = { functions: 80, lines: 92 };
		expect(checkBudgets(totals, budgets)).toEqual([{ metric: "functions", actual: 80, floor: 85 }]);
	});

	test("flags lines below floor", () => {
		const totals: CoverageTotals = { functions: 95, lines: 80 };
		expect(checkBudgets(totals, budgets)).toEqual([{ metric: "lines", actual: 80, floor: 90 }]);
	});

	test("flags both when both drop", () => {
		const totals: CoverageTotals = { functions: 10, lines: 20 };
		const failures = checkBudgets(totals, budgets);
		expect(failures.map((f) => f.metric).sort()).toEqual(["functions", "lines"]);
	});
});

describe("check-coverage CLI (--parse)", () => {
	const SCRIPT = resolve(import.meta.dir, "check-coverage.ts");

	function runParse(log: string | undefined): { status: number; stdout: string; stderr: string } {
		const dir = mkdtempSync(join(tmpdir(), "check-coverage-"));
		try {
			const args = [SCRIPT, "--parse"];
			if (log !== undefined) {
				const file = join(dir, "log.txt");
				writeFileSync(file, log);
				args.push(file);
			} else {
				args.push(join(dir, "missing.txt"));
			}
			const result = spawnSync("bun", args, { encoding: "utf8" });
			return {
				status: result.status ?? -1,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("exits 0 and prints the summary when totals clear the floors", () => {
		const log = " All files                            |  100.00 |  100.00 |\n";
		const r = runParse(log);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("Coverage — functions 100.00%");
	});

	test("exits 1 when a floor is missed (warren-66a7: no process.exit truncation)", () => {
		// Large tail after the table — the whole buffer must survive to the pipe.
		const tail = `${"x".repeat(1_000_000)}\nTAIL-MARKER\n`;
		const log = ` All files                            |    0.00 |    0.00 |\n${tail}`;
		const r = runParse(log);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("functions coverage 0.00% is below floor");
	});

	test("exits 1 when the All files row is missing", () => {
		const r = runParse("no table\n");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not find 'All files' row");
	});

	test("exits 2 when the --parse file does not exist", () => {
		const r = runParse(undefined);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--parse expected an existing file");
	});
});
