/**
 * Unit tests for the Plot ID format validator (warren-bae5 / pl-5310
 * step 2). The HTTP-edge wiring is covered by handlers.test.ts and
 * handlers.plan-runs.test.ts; this file pins the regex itself so any
 * future relaxation (e.g. allowing uppercase or underscores) is a
 * deliberate, test-visible change.
 */

import { describe, expect, test } from "bun:test";
import { isValidPlotIdFormat, PLOT_ID_REGEX } from "./id-validator.ts";

describe("isValidPlotIdFormat", () => {
	test("accepts canonical plot ids minted by @os-eco/plot-cli", () => {
		expect(isValidPlotIdFormat("plot-3e72876d")).toBe(true);
		expect(isValidPlotIdFormat("plot-abc")).toBe(true);
		expect(isValidPlotIdFormat("plot-0")).toBe(true);
		expect(isValidPlotIdFormat("plot-deadbeef0123")).toBe(true);
	});

	test("rejects the literal 'plot_id=plot-…' shape that motivated warren-a353", () => {
		expect(isValidPlotIdFormat("plot_id=plot-3e72876d")).toBe(false);
	});

	test("rejects shapes that aren't plot-<lower-alphanum>+", () => {
		expect(isValidPlotIdFormat("plot_abc")).toBe(false); // underscore separator
		expect(isValidPlotIdFormat("PLOT-abc")).toBe(false); // uppercase prefix
		expect(isValidPlotIdFormat("plot-ABC")).toBe(false); // uppercase suffix
		expect(isValidPlotIdFormat("plot-")).toBe(false); // empty suffix
		expect(isValidPlotIdFormat("plot-abc-def")).toBe(false); // extra separator
		expect(isValidPlotIdFormat("plot-abc ")).toBe(false); // trailing space
		expect(isValidPlotIdFormat(" plot-abc")).toBe(false); // leading space
		expect(isValidPlotIdFormat("xplot-abc")).toBe(false); // wrong prefix
		expect(isValidPlotIdFormat("")).toBe(false); // empty
	});

	test("PLOT_ID_REGEX is exported for callers needing the raw pattern (e.g. NewRun client validation)", () => {
		expect(PLOT_ID_REGEX.test("plot-3e72876d")).toBe(true);
		expect(PLOT_ID_REGEX.test("plot_id=plot-3e72876d")).toBe(false);
	});
});
