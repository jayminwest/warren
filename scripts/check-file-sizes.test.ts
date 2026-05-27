import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scan } from "./check-file-sizes.ts";

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
});
