import { describe, expect, test } from "bun:test";
import type { SortState } from "@/components/ui/sortable-table-head.helpers.ts";
import { applySort, compareStrings, type Comparator } from "./use-client-sort.helpers.ts";

interface Row {
	name: string;
	weight: number | null;
}

const COMPARATORS: Record<"name" | "weight", Comparator<Row>> = {
	name: (a, b) => compareStrings(a.name, b.name),
	weight: (a, b) => (a.weight ?? 0) - (b.weight ?? 0),
};

const ROWS: Row[] = [
	{ name: "charlie", weight: 2 },
	{ name: "alpha", weight: 3 },
	{ name: "bravo", weight: 1 },
];

describe("compareStrings", () => {
	test("orders non-null strings lexically", () => {
		expect(compareStrings("a", "b")).toBeLessThan(0);
		expect(compareStrings("b", "a")).toBeGreaterThan(0);
		expect(compareStrings("a", "a")).toBe(0);
	});

	test("sorts nullish values ahead of present values", () => {
		expect(compareStrings(null, "a")).toBe(-1);
		expect(compareStrings("a", undefined)).toBe(1);
		expect(compareStrings(null, undefined)).toBe(0);
	});
});

describe("applySort", () => {
	test("sorts ascending by the active column without mutating input", () => {
		const sort: SortState<"name" | "weight"> = { key: "name", direction: "asc" };
		const out = applySort(ROWS, COMPARATORS, sort);
		expect(out.map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
		expect(ROWS[0]?.name).toBe("charlie");
	});

	test("flips ordering for descending direction", () => {
		const sort: SortState<"name" | "weight"> = { key: "weight", direction: "desc" };
		const out = applySort(ROWS, COMPARATORS, sort);
		expect(out.map((r) => r.weight)).toEqual([3, 2, 1]);
	});

	test("returns an unsorted copy when no column is active", () => {
		const sort: SortState<"name" | "weight"> = { key: null, direction: "asc" };
		const out = applySort(ROWS, COMPARATORS, sort);
		expect(out).toEqual(ROWS);
		expect(out).not.toBe(ROWS);
	});
});
