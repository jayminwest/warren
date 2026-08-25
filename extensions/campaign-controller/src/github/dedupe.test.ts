import { describe, expect, test } from "bun:test";
import { dedupeByNodeId, filterNewByNodeId } from "./dedupe.ts";

describe("dedupeByNodeId", () => {
	test("keeps the first occurrence of each node id in order", () => {
		const result = dedupeByNodeId([
			{ nodeId: "a", body: "first" },
			{ nodeId: "b", body: "b" },
			{ nodeId: "a", body: "duplicate" },
		]);
		expect(result.items).toEqual([
			{ nodeId: "a", body: "first" },
			{ nodeId: "b", body: "b" },
		]);
		expect(result.duplicateCount).toBe(1);
		expect(result.duplicateNodeIds).toEqual(["a"]);
	});

	test("counts multiple duplicates across many node ids", () => {
		const result = dedupeByNodeId([
			{ nodeId: "a" },
			{ nodeId: "b" },
			{ nodeId: "a" },
			{ nodeId: "c" },
			{ nodeId: "b" },
			{ nodeId: "b" },
		]);
		expect(result.items.map((item) => item.nodeId)).toEqual(["a", "b", "c"]);
		expect(result.duplicateCount).toBe(3);
		expect(result.duplicateNodeIds).toEqual(["a", "b"]);
	});

	test("an empty node id is kept, never deduplicated", () => {
		const result = dedupeByNodeId([{ nodeId: "" }, { nodeId: "" }]);
		expect(result.items.length).toBe(2);
		expect(result.duplicateCount).toBe(0);
	});
});

describe("filterNewByNodeId", () => {
	test("returns only never-seen items and grows the known set in place", () => {
		const known = new Set<string>(["a"]);
		const fresh = filterNewByNodeId(known, [
			{ nodeId: "a" },
			{ nodeId: "b" },
			{ nodeId: "c" },
			{ nodeId: "b" },
		]);
		expect(fresh.map((item) => item.nodeId)).toEqual(["b", "c"]);
		expect(known.has("c")).toBe(true);
	});

	test("a replayed batch yields nothing new", () => {
		const known = new Set<string>();
		const batch = [{ nodeId: "x" }, { nodeId: "y" }];
		filterNewByNodeId(known, batch);
		expect(filterNewByNodeId(known, batch)).toEqual([]);
	});
});
