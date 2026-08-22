import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { headroomReport, type Measurement, parseHeadroom, scan } from "./check-file-sizes.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("check-file-sizes", () => {
	test("current tree passes the budget guard", () => {
		const { failures, staleBudgetEntries } = scan();
		expect(failures).toEqual([]);
		expect(staleBudgetEntries).toEqual([]);
	});

	test("budgets file is well-formed", () => {
		const raw = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "scripts/file-size-budgets.json"), "utf8"),
		) as { threshold: number; budgets: Record<string, number> };
		expect(typeof raw.threshold).toBe("number");
		expect(raw.threshold).toBeGreaterThan(0);
		for (const [path, value] of Object.entries(raw.budgets)) {
			expect(value, `${path}: budget must be a positive integer`).toBeGreaterThan(0);
			expect(value, `${path}: budget must exceed threshold`).toBeGreaterThan(raw.threshold);
		}
	});

	test("every walked file is measured against the ceiling that applies to it", () => {
		const { measurements } = scan();
		expect(measurements.length).toBeGreaterThan(0);
		for (const m of measurements) {
			expect(m.budget, `${m.path}: budget must be positive`).toBeGreaterThan(0);
			expect(m.lines, `${m.path}: lines must not be negative`).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("headroomReport", () => {
	const tree: Measurement[] = [
		{ path: "roomy.ts", lines: 100, budget: 500 },
		{ path: "at-ceiling.ts", lines: 500, budget: 500 },
		{ path: "over.ts", lines: 503, budget: 500 },
		{ path: "close.ts", lines: 494, budget: 500 },
		{ path: "way-over.ts", lines: 540, budget: 500 },
	];

	test("splits the files already over budget from the ones near the ceiling", () => {
		const { over, near } = headroomReport(10, tree);
		expect(over.map((m) => m.path)).toEqual(["way-over.ts", "over.ts"]);
		expect(near.map((m) => m.path)).toEqual(["at-ceiling.ts", "close.ts"]);
	});

	test("counts a file sitting exactly at its ceiling as zero headroom, not as over", () => {
		const { over, near } = headroomReport(0, tree);
		expect(over.map((m) => m.path)).not.toContain("at-ceiling.ts");
		expect(near.map((m) => m.path)).toEqual(["at-ceiling.ts"]);
	});

	test("leaves out a file with more headroom than asked for", () => {
		const { near } = headroomReport(5, tree);
		expect(near.map((m) => m.path)).not.toContain("roomy.ts");
	});
});

describe("parseHeadroom", () => {
	test("reads both the spaced and the joined form", () => {
		expect(parseHeadroom(["--headroom", "10"])).toBe(10);
		expect(parseHeadroom(["--headroom=10"])).toBe(10);
		expect(parseHeadroom(["--headroom", "0"])).toBe(0);
	});

	test("returns null when the flag is absent, so the gate still runs", () => {
		expect(parseHeadroom([])).toBeNull();
		expect(parseHeadroom(["--report"])).toBeNull();
	});

	test("refuses a value that is not a whole number of lines", () => {
		expect(() => parseHeadroom(["--headroom"])).toThrow(/whole number/);
		expect(() => parseHeadroom(["--headroom", "ten"])).toThrow(/whole number/);
		expect(() => parseHeadroom(["--headroom", "-1"])).toThrow(/whole number/);
		expect(() => parseHeadroom(["--headroom", "1.5"])).toThrow(/whole number/);
	});
});
