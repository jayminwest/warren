import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CANONICAL_GATES,
	extractFailureSignatures,
	formatGateLine,
	GATES,
	gateLogName,
	loadScripts,
	resolveGates,
	resolveLogDir,
} from "./check-all.ts";

const CANONICAL_ORDER = CANONICAL_GATES.map((g) => g.name);

describe("check-all", () => {
	test("canonical order: lint first, coverage second-to-last, ci-parity last", () => {
		expect(CANONICAL_ORDER[0]).toBe("lint");
		expect(CANONICAL_ORDER[CANONICAL_ORDER.length - 2]).toBe("check:coverage");
		expect(CANONICAL_ORDER[CANONICAL_ORDER.length - 1]).toBe("check:ci-parity");
	});

	test("resolveGates includes every core gate even when scripts are missing", () => {
		const gates = resolveGates({});
		expect(gates).toEqual(CANONICAL_GATES.filter((g) => !g.conditional).map((g) => g.name));
	});

	test("resolveGates includes conditional gates only when defined, preserving order", () => {
		const gates = resolveGates({
			"gen:docs:check": "bun run scripts/generate-docs.ts --check",
		});
		expect(gates).toContain("gen:docs:check");
		expect(gates).not.toContain("check:bundle-size");
		expect(gates).not.toContain("gen:openapi:check");
		expect(gates.indexOf("gen:docs:check")).toBeGreaterThan(gates.indexOf("check:debt"));
		expect(gates.indexOf("gen:docs:check")).toBeLessThan(gates.indexOf("check:coverage"));
	});

	test("resolveGates with all conditionals defined yields the full canonical list", () => {
		const gates = resolveGates({
			"check:bundle-size": "x",
			"gen:docs:check": "x",
			"gen:openapi:check": "x",
		});
		expect(gates).toEqual(CANONICAL_ORDER);
	});

	test("GATES is a canonical-order subsequence ending in check:ci-parity", () => {
		const indices = GATES.map((g) => CANONICAL_ORDER.indexOf(g));
		expect(indices).not.toContain(-1);
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
		expect(GATES[GATES.length - 1]).toBe("check:ci-parity");
	});

	test("loadScripts tolerates a missing package.json", () => {
		expect(loadScripts("/nonexistent/package.json")).toEqual({});
	});

	test("formatGateLine aligns names and renders status marks", () => {
		expect(formatGateLine("ok", "lint", 1.23, 10)).toBe("✓ lint       (1.2s)");
		expect(formatGateLine("fail", "check:dups", 0.05, 10)).toBe("✗ check:dups (0.1s)");
	});

	test("extractFailureSignatures picks bun-test fail lines over noise", () => {
		const output = [
			"bun test v1.2.0",
			"(pass) suite > passing test [0.10ms]",
			"(fail) suite > broken test [0.42ms]",
			"  expected 1, got 2",
			"(fail) suite > other broken test [0.11ms]",
			"  12 pass",
			"  2 fail",
		].join("\n");
		const sig = extractFailureSignatures(output);
		expect(sig).toContain("(fail) suite > broken test [0.42ms]");
		expect(sig).toContain("(fail) suite > other broken test [0.11ms]");
		expect(sig).not.toContain("(pass) suite > passing test [0.10ms]");
	});

	test("extractFailureSignatures picks tsc error lines", () => {
		const output = [
			"src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"Found 1 error.",
		].join("\n");
		expect(extractFailureSignatures(output)[0]).toContain("error TS2322");
	});

	test("extractFailureSignatures falls back to the output tail", () => {
		const output = ["line one", "", "line two", "budget exceeded somehow"].join("\n");
		const sig = extractFailureSignatures(output);
		expect(sig.length).toBeGreaterThan(0);
		expect(sig).not.toContain("");
	});

	// warren-7e82: replayed shape of an observed check:coverage failure.
	// Every test passed, but a passing test's NAME matched the budget
	// pattern and the generic script-exit trailer matched `^Error: `, so the
	// tail fallback never ran and the real below-floor lines were dropped.
	test("extractFailureSignatures reports coverage below-floor lines, not passing test names", () => {
		const output = [
			"$ bun run scripts/check-coverage.ts --fail-when-exceeds-budget",
			"bun test v1.2.0",
			"(pass) check-file-sizes > fails when a file exceeds its frozen budget [0.31ms]",
			"(pass) check-debt > errors when the marker budget is exceeded [0.12ms]",
			"(skip) slow suite > exceeds budget under load",
			" 412 pass",
			" 0 fail",
			"All files                 |   61.58 |   66.47 |",
			"Coverage — functions 61.58% (floor 97.00%), lines 66.47% (floor 97.00%)",
			"check-coverage: [aggregate] functions coverage 61.58% is below floor 97.00%. Add tests to lift it.",
			"check-coverage: [aggregate] lines coverage 66.47% is below floor 97.00%. Add tests to lift it.",
			'error: script "check:coverage" exited with code 1',
		].join("\n");
		const sig = extractFailureSignatures(output);
		expect(sig).toEqual([
			"check-coverage: [aggregate] functions coverage 61.58% is below floor 97.00%. Add tests to lift it.",
			"check-coverage: [aggregate] lines coverage 66.47% is below floor 97.00%. Add tests to lift it.",
		]);
	});

	test("extractFailureSignatures still reports a failing test named after a budget", () => {
		const output = [
			"(pass) sizes > passes a file under its frozen budget [0.10ms]",
			"(fail) sizes > fails when a file exceeds its frozen budget [0.20ms]",
			'error: script "check:coverage" exited with code 1',
		].join("\n");
		expect(extractFailureSignatures(output)).toEqual([
			"(fail) sizes > fails when a file exceeds its frozen budget [0.20ms]",
		]);
	});

	test("extractFailureSignatures ignores the script-exit trailer and falls back to the tail", () => {
		const output = [
			"src/huge.ts: 612 lines (ceiling 500)",
			'error: script "check:size" exited with code 1',
		].join("\n");
		const sig = extractFailureSignatures(output);
		expect(sig).toContain("src/huge.ts: 612 lines (ceiling 500)");
	});

	test("extractFailureSignatures reports a coverage run that never printed a totals row", () => {
		const output = [
			"(pass) a > b [0.1ms]",
			"check-coverage: could not find 'All files' row in test output — did the test run finish?",
			'error: script "check:coverage" exited with code 1',
		].join("\n");
		expect(extractFailureSignatures(output)).toEqual([
			"check-coverage: could not find 'All files' row in test output — did the test run finish?",
		]);
	});

	test("resolveLogDir honors CHECK_ALL_LOG_DIR", () => {
		expect(resolveLogDir("/repo/x", { CHECK_ALL_LOG_DIR: "/var/tmp/gate-logs" })).toBe(
			"/var/tmp/gate-logs",
		);
	});

	test("resolveLogDir defaults to a stable per-checkout dir under the OS temp dir", () => {
		const a = resolveLogDir("/work/repo", {});
		expect(a.startsWith(join(tmpdir(), "check-all"))).toBe(true);
		expect(a).toContain("repo-");
		expect(resolveLogDir("/work/repo", {})).toBe(a);
		expect(resolveLogDir("/other/repo", {})).not.toBe(a);
	});

	test("gateLogName makes a gate name file-safe", () => {
		expect(gateLogName("check:coverage")).toBe("check-coverage.log");
		expect(gateLogName("gen:openapi:check")).toBe("gen-openapi-check.log");
		expect(gateLogName("lint")).toBe("lint.log");
	});
});
