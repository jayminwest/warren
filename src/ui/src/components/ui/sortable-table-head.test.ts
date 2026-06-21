import { describe, expect, test } from "bun:test";
import {
	ariaSortFor,
	nextSortState,
	type SortState,
} from "./sortable-table-head.helpers.ts";

type Key = "name" | "started";

describe("ariaSortFor", () => {
	test("reports none for inactive column", () => {
		const state: SortState<Key> = { key: "name", direction: "asc" };
		expect(ariaSortFor("started", state)).toBe("none");
	});

	test("maps active ascending/descending to ARIA tokens", () => {
		expect(ariaSortFor("name", { key: "name", direction: "asc" })).toBe("ascending");
		expect(ariaSortFor("name", { key: "name", direction: "desc" })).toBe("descending");
	});

	test("reports none when nothing is sorted", () => {
		expect(ariaSortFor("name", { key: null, direction: "asc" })).toBe("none");
	});
});

describe("nextSortState", () => {
	test("toggles direction when the active column is re-activated", () => {
		expect(nextSortState({ key: "name", direction: "asc" }, "name")).toEqual({
			key: "name",
			direction: "desc",
		});
		expect(nextSortState({ key: "name", direction: "desc" }, "name")).toEqual({
			key: "name",
			direction: "asc",
		});
	});

	test("adopts default ascending direction when switching columns", () => {
		expect(nextSortState({ key: "name", direction: "desc" }, "started")).toEqual({
			key: "started",
			direction: "asc",
		});
	});

	test("honors an explicit default direction when switching columns", () => {
		expect(nextSortState({ key: "name", direction: "asc" }, "started", "desc")).toEqual({
			key: "started",
			direction: "desc",
		});
	});
});
