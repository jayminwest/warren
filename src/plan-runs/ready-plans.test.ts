import { describe, expect, test } from "bun:test";
import { computeReadyPlans, type ReadyPlanInput } from "./ready-plans.ts";

function statusMap(entries: Record<string, string>): ReadonlyMap<string, string> {
	return new Map(Object.entries(entries));
}

describe("computeReadyPlans", () => {
	test("includes approved plan with an open, undispatched child", () => {
		const plans: ReadyPlanInput[] = [
			{ id: "pl-1", name: "Ship it", status: "approved", children: ["s-1", "s-2"] },
		];
		const result = computeReadyPlans({
			plans,
			seedStatusById: statusMap({ "s-1": "open", "s-2": "closed" }),
			dispatchedPlanIds: new Set(),
		});
		expect(result).toEqual([
			{ id: "pl-1", name: "Ship it", status: "approved", openChildCount: 1 },
		]);
	});

	test("excludes approved plan whose children are all closed", () => {
		const result = computeReadyPlans({
			plans: [{ id: "pl-1", status: "approved", children: ["s-1", "s-2"] }],
			seedStatusById: statusMap({ "s-1": "closed", "s-2": "closed" }),
			dispatchedPlanIds: new Set(),
		});
		expect(result).toEqual([]);
	});

	test("excludes approved plan that is already dispatched", () => {
		const result = computeReadyPlans({
			plans: [{ id: "pl-1", status: "approved", children: ["s-1"] }],
			seedStatusById: statusMap({ "s-1": "open" }),
			dispatchedPlanIds: new Set(["pl-1"]),
		});
		expect(result).toEqual([]);
	});

	test("excludes non-approved plans regardless of open children", () => {
		const result = computeReadyPlans({
			plans: [
				{ id: "pl-draft", status: "draft", children: ["s-1"] },
				{ id: "pl-rejected", status: "rejected", children: ["s-2"] },
			],
			seedStatusById: statusMap({ "s-1": "open", "s-2": "open" }),
			dispatchedPlanIds: new Set(),
		});
		expect(result).toEqual([]);
	});

	test("counts every open child, treating unknown ids as open", () => {
		const result = computeReadyPlans({
			plans: [{ id: "pl-1", status: "approved", children: ["s-1", "s-2", "s-missing"] }],
			seedStatusById: statusMap({ "s-1": "open", "s-2": "closed" }),
			dispatchedPlanIds: new Set(),
		});
		expect(result).toEqual([{ id: "pl-1", status: "approved", openChildCount: 2 }]);
	});

	test("omits name when not provided", () => {
		const result = computeReadyPlans({
			plans: [{ id: "pl-1", status: "approved", children: ["s-1"] }],
			seedStatusById: statusMap({ "s-1": "open" }),
			dispatchedPlanIds: new Set(),
		});
		expect(result[0]).not.toHaveProperty("name");
	});

	test("returns empty array for no plans", () => {
		const result = computeReadyPlans({
			plans: [],
			seedStatusById: statusMap({}),
			dispatchedPlanIds: new Set(),
		});
		expect(result).toEqual([]);
	});
});
