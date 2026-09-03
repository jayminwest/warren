import { describe, expect, test } from "bun:test";
import {
	cacheHitShare,
	dateBucketLabel,
	dateSpendSeries,
	sortBucketsDesc,
	topCostBuckets,
} from "./economics-helpers.ts";

const bucket = (key: string, costUsd: number) => ({ key, costUsd, runs: 1, priced: 1 });

describe("sortBucketsDesc", () => {
	test("orders most expensive first", () => {
		const out = sortBucketsDesc([bucket("a", 1), bucket("b", 3), bucket("c", 2)]);
		expect(out.map((b) => b.key)).toEqual(["b", "c", "a"]);
	});
	test("does not mutate the input", () => {
		const input = [bucket("a", 2), bucket("b", 1)];
		sortBucketsDesc(input);
		expect(input.map((b) => b.key)).toEqual(["a", "b"]);
	});
});

describe("topCostBuckets", () => {
	test("slices to the requested count in descending order", () => {
		const out = topCostBuckets([bucket("a", 5), bucket("b", 1), bucket("c", 4), bucket("d", 2)], 2);
		expect(out.map((b) => b.key)).toEqual(["a", "c"]);
	});
	test("returns all buckets when fewer than the cap", () => {
		expect(topCostBuckets([bucket("a", 1)], 10)).toHaveLength(1);
		expect(topCostBuckets([], 10)).toEqual([]);
	});
});

describe("dateSpendSeries", () => {
	test("orders date keys oldest first", () => {
		const out = dateSpendSeries([bucket("2026-09-03", 1), bucket("2026-09-01", 2)]);
		expect(out.map((b) => b.key)).toEqual(["2026-09-01", "2026-09-03"]);
	});
	test("sorts date keys, sentinel first lexicographically", () => {
		const out = dateSpendSeries([bucket("2026-09-02", 1), bucket("__none__", 2)]);
		expect(out[0]?.key).toBe("__none__");
	});
});

describe("dateBucketLabel", () => {
	test("strips the year from an ISO date key", () => {
		expect(dateBucketLabel("2026-09-03")).toBe("09-03");
	});
	test("labels the unattributed sentinel", () => {
		expect(dateBucketLabel("__none__")).toBe("(unattributed)");
	});
	test("passes through unrecognized keys", () => {
		expect(dateBucketLabel("weird")).toBe("weird");
	});
});

describe("cacheHitShare", () => {
	test("computes cacheRead / (input + cacheRead)", () => {
		expect(cacheHitShare({ input: 40, output: 10, cacheRead: 60, cacheWrite: 5, total: 115 })).toBe(
			0.6,
		);
	});
	test("is null when the breakdown is absent", () => {
		expect(cacheHitShare(undefined)).toBeNull();
	});
	test("is null when there are no input or cache-read tokens", () => {
		expect(
			cacheHitShare({ input: 0, output: 7, cacheRead: 0, cacheWrite: 0, total: 7 }),
		).toBeNull();
	});
});
