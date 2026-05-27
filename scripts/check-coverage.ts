#!/usr/bin/env bun
/**
 * Coverage guard (warren-e4b1, plan pl-7b06 step 17).
 *
 * Wraps `bun test --coverage` so CI gets:
 *   1. A normal test run (failures still fail the step).
 *   2. A text coverage table in the log.
 *   3. An `coverage/lcov.info` artifact for downstream tooling.
 *   4. A JUnit XML report (when --junit is passed) for the timing
 *      summary in `report-test-timing.ts`.
 *   5. Ratchet enforcement of the floors in
 *      `scripts/coverage-budgets.json`.
 *
 * The floors are read from `scripts/coverage-budgets.json` and compared
 * against the "All files" row emitted by Bun's text coverage reporter.
 * That row is the canonical user-visible aggregate; lcov line totals
 * diverge from it (lcov DA lines include non-executable spans), so we
 * parse the text reporter directly.
 *
 * The ratchet only goes UP. To raise a floor, add tests, observe the
 * new aggregate in CI, then bump `coverage-budgets.json`. Lowering a
 * floor requires deleting tests, which should be a conscious decision
 * with a tracker reference, not a silent ratchet move.
 *
 * Usage:
 *   bun run scripts/check-coverage.ts             # run tests + enforce
 *   bun run scripts/check-coverage.ts --junit     # also emit junit.xml
 *   bun run scripts/check-coverage.ts --parse FILE  # offline: parse a captured log
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/coverage-budgets.json");
const COVERAGE_DIR = resolve(REPO_ROOT, "coverage");
const JUNIT_DIR = resolve(REPO_ROOT, "test-results");
const JUNIT_PATH = resolve(JUNIT_DIR, "junit.xml");

export interface CoverageBudgets {
	functions: number;
	lines: number;
}

export interface CoverageTotals {
	functions: number;
	lines: number;
}

export interface CoverageFailure {
	metric: "functions" | "lines";
	actual: number;
	floor: number;
}

export function loadBudgets(raw: string): CoverageBudgets {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const fns = parsed.functions;
	const lines = parsed.lines;
	if (typeof fns !== "number" || !Number.isFinite(fns) || fns < 0 || fns > 100) {
		throw new Error(`${BUDGETS_PATH}: 'functions' must be a percentage in [0, 100]`);
	}
	if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 0 || lines > 100) {
		throw new Error(`${BUDGETS_PATH}: 'lines' must be a percentage in [0, 100]`);
	}
	return { functions: fns, lines };
}

/**
 * Parse the "All files" row of Bun's text coverage reporter.
 *
 * Example row (columns are `% Funcs | % Lines | Uncovered Line #s`):
 *
 *   All files                             |   86.25 |   91.62 |
 *
 * Returns `undefined` when the row is absent (e.g. tests failed before
 * the reporter ran).
 */
export function parseAllFilesRow(output: string): CoverageTotals | undefined {
	// Strip ANSI escape codes before matching — Bun's reporter colors numbers
	// when stdout is a TTY but not in CI; be defensive either way.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI CSI sequences
	const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
	const match = plain.match(/^\s*All files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/m);
	if (!match) return undefined;
	const functions = Number.parseFloat(match[1] ?? "");
	const lines = Number.parseFloat(match[2] ?? "");
	if (!Number.isFinite(functions) || !Number.isFinite(lines)) return undefined;
	return { functions, lines };
}

export function checkBudgets(totals: CoverageTotals, budgets: CoverageBudgets): CoverageFailure[] {
	const failures: CoverageFailure[] = [];
	if (totals.functions < budgets.functions) {
		failures.push({ metric: "functions", actual: totals.functions, floor: budgets.functions });
	}
	if (totals.lines < budgets.lines) {
		failures.push({ metric: "lines", actual: totals.lines, floor: budgets.lines });
	}
	return failures;
}

function formatLine(totals: CoverageTotals, budgets: CoverageBudgets): string {
	return `Coverage — functions ${totals.functions.toFixed(2)}% (floor ${budgets.functions.toFixed(2)}%), lines ${totals.lines.toFixed(2)}% (floor ${budgets.lines.toFixed(2)}%)`;
}

function printRatchetHint(totals: CoverageTotals, budgets: CoverageBudgets): void {
	const fnSlack = totals.functions - budgets.functions;
	const lineSlack = totals.lines - budgets.lines;
	const RATCHET_HINT = 2.0;
	if (fnSlack >= RATCHET_HINT || lineSlack >= RATCHET_HINT) {
		const suggested = {
			functions: Math.max(budgets.functions, Math.floor(totals.functions * 100) / 100 - 0.5),
			lines: Math.max(budgets.lines, Math.floor(totals.lines * 100) / 100 - 0.5),
		};
		console.error(
			`check-coverage: coverage exceeds floors by ≥${RATCHET_HINT}pt — consider ratcheting scripts/coverage-budgets.json up to e.g. {functions: ${suggested.functions.toFixed(2)}, lines: ${suggested.lines.toFixed(2)}}.`,
		);
	}
}

function writeSummaryArtifact(totals: CoverageTotals): void {
	// Persist the *text-reporter* totals so downstream consumers
	// (e.g. scripts/report-quality-metrics.ts, warren-5b95) can render the
	// same numbers users see in the CI log. lcov.info aggregates diverge
	// here (it counts non-executable spans), so this JSON is the source of
	// truth for the "All files" aggregate.
	try {
		mkdirSync(COVERAGE_DIR, { recursive: true });
		writeFileSync(
			resolve(COVERAGE_DIR, "summary.json"),
			`${JSON.stringify({ functions: totals.functions, lines: totals.lines }, null, 2)}\n`,
		);
	} catch (err) {
		console.error(`check-coverage: failed to write coverage/summary.json: ${err}`);
	}
}

function reportResult(
	totals: CoverageTotals | undefined,
	budgets: CoverageBudgets,
	testExitCode: number,
): number {
	if (totals) writeSummaryArtifact(totals);
	if (!totals) {
		console.error(
			"check-coverage: could not find 'All files' row in test output — did the test run finish?",
		);
		return testExitCode === 0 ? 1 : testExitCode;
	}
	const failures = checkBudgets(totals, budgets);
	console.error(formatLine(totals, budgets));
	if (failures.length > 0) {
		for (const f of failures) {
			console.error(
				`check-coverage: ${f.metric} coverage ${f.actual.toFixed(2)}% is below floor ${f.floor.toFixed(2)}%. Add tests to lift it, or — if you're intentionally removing coverage — document the drop and lower the floor in scripts/coverage-budgets.json.`,
			);
		}
		return testExitCode === 0 ? 1 : testExitCode;
	}
	printRatchetHint(totals, budgets);
	return testExitCode;
}

function runBunTest(emitJUnit: boolean): { exitCode: number; combined: string } {
	mkdirSync(COVERAGE_DIR, { recursive: true });
	const args = [
		"test",
		"--coverage",
		"--coverage-reporter=text",
		"--coverage-reporter=lcov",
		`--coverage-dir=${COVERAGE_DIR}`,
	];
	if (emitJUnit) {
		mkdirSync(JUNIT_DIR, { recursive: true });
		args.push("--reporter=junit", `--reporter-outfile=${JUNIT_PATH}`);
	}
	// Bun writes both progress and the coverage table to stderr. Capture both
	// streams as strings and tee them through so the user still sees live
	// output, then parse from the buffered copy.
	const result = spawnSync("bun", args, { cwd: REPO_ROOT, encoding: "utf8" });
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	process.stdout.write(stdout);
	process.stderr.write(stderr);
	const exitCode = result.status ?? (result.signal ? 1 : 0);
	return { exitCode, combined: `${stdout}\n${stderr}` };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const parseIdx = argv.indexOf("--parse");
	const emitJUnit = argv.includes("--junit");

	const budgets = loadBudgets(readFileSync(BUDGETS_PATH, "utf8"));

	if (parseIdx !== -1) {
		const file = argv[parseIdx + 1];
		if (!file || !existsSync(file)) {
			console.error(`check-coverage: --parse expected an existing file, got ${file ?? "<none>"}`);
			process.exit(2);
		}
		const totals = parseAllFilesRow(readFileSync(file, "utf8"));
		process.exit(reportResult(totals, budgets, 0));
	}

	const { exitCode, combined } = runBunTest(emitJUnit);
	const totals = parseAllFilesRow(combined);
	process.exit(reportResult(totals, budgets, exitCode));
}

if (import.meta.main) {
	await main();
}
