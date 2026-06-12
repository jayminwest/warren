import { describe, expect, test } from "bun:test";
import {
	CANONICAL_GATES,
	extractFailureSignatures,
	formatGateLine,
	GATES,
	loadScripts,
	resolveGates,
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
});
