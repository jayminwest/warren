import { describe, expect, test } from "bun:test";
import {
	isWithinAutomaticRunWindow,
	resolveAutomaticRunPolicy,
	withAutomaticRunAdmission,
} from "./automatic-capacity.ts";

const MADRID_WINDOW = "02:00-09:00@Europe/Madrid";

function policy(maxConcurrentRuns = 1) {
	return { maxConcurrentRuns, window: MADRID_WINDOW };
}

describe("automatic run window", () => {
	test.each([
		["winter start is inclusive", "2026-01-01T01:00:00.000Z", true],
		["winter end is exclusive", "2026-01-01T08:00:00.000Z", false],
		["summer start is inclusive", "2026-06-01T00:00:00.000Z", true],
		["summer end is exclusive", "2026-06-01T07:00:00.000Z", false],
		["one minute before start is outside", "2026-01-01T00:59:00.000Z", false],
		["one minute before end is inside", "2026-01-01T07:59:00.000Z", true],
	] as const)("%s", (_label, iso, expected) => {
		expect(isWithinAutomaticRunWindow(new Date(iso), MADRID_WINDOW)).toBe(expected);
	});

	test("allows scheduling at any time when the window is unset", () => {
		expect(isWithinAutomaticRunWindow(new Date("2026-06-01T15:00:00.000Z"), undefined)).toBe(true);
	});

	test("fails closed for invalid windows", () => {
		const now = new Date("2026-06-01T00:30:00.000Z");
		expect(isWithinAutomaticRunWindow(now, "02:00-09:00@not/a-zone")).toBe(false);
		expect(isWithinAutomaticRunWindow(now, "02:00-09:00")).toBe(false);
	});

	test("supports windows that cross midnight", () => {
		expect(
			isWithinAutomaticRunWindow(new Date("2026-01-01T22:00:00.000Z"), "23:00-02:00@Europe/Madrid"),
		).toBe(true);
		expect(
			isWithinAutomaticRunWindow(new Date("2026-01-02T01:00:00.000Z"), "23:00-02:00@Europe/Madrid"),
		).toBe(false);
		expect(isWithinAutomaticRunWindow(new Date(), "25:00-02:00@Europe/Madrid")).toBe(false);
	});

	test("resolves per-instance limits with a safe default", () => {
		expect(resolveAutomaticRunPolicy({})).toEqual({ maxConcurrentRuns: 1, window: undefined });
		expect(
			resolveAutomaticRunPolicy({
				WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS: "3",
				WARREN_AUTOMATIC_RUN_WINDOW: MADRID_WINDOW,
			}),
		).toEqual({ maxConcurrentRuns: 3, window: MADRID_WINDOW });
		expect(
			resolveAutomaticRunPolicy({ WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS: "0" }).maxConcurrentRuns,
		).toBe(1);
	});

	test("does not invoke automatic work outside the configured window", async () => {
		let workStarted = false;
		let capacityChecks = 0;
		const result = await withAutomaticRunAdmission(
			{
				async countNonTerminalAutomatic() {
					capacityChecks += 1;
					return 0;
				},
			},
			async () => {
				workStarted = true;
				return "started";
			},
			new Date("2026-06-01T07:00:00.000Z"),
			policy(),
		);

		expect(result).toEqual({ admitted: false });
		expect(workStarted).toBe(false);
		expect(capacityChecks).toBe(0);
	});

	test("admits at most one overlapping automatic dispatch by default", async () => {
		let releaseWork: (() => void) | undefined;
		let workStarted = 0;
		const runs = {
			async countNonTerminalAutomatic() {
				return 0;
			},
		};
		const now = new Date("2026-06-01T00:00:00.000Z");
		const work = () => {
			workStarted += 1;
			return new Promise<string>((resolve) => {
				releaseWork = () => resolve("started");
			});
		};

		const first = withAutomaticRunAdmission(runs, work, now, policy());
		await Promise.resolve();
		const second = await withAutomaticRunAdmission(runs, work, now, policy());
		releaseWork?.();
		const firstResult = await first;

		expect(firstResult).toEqual({ admitted: true, value: "started" });
		expect(second).toEqual({ admitted: false });
		expect(workStarted).toBe(1);
	});

	test("admits three runs when an operator sets a per-instance limit of three", async () => {
		let activeRuns = 0;
		let dispatches = 0;
		const runs = {
			async countNonTerminalAutomatic() {
				return activeRuns;
			},
		};
		const work = async () => {
			dispatches += 1;
			activeRuns += 1;
			return dispatches;
		};
		const now = new Date("2026-06-01T00:00:00.000Z");
		const testPolicy = policy(3);

		const results = [
			await withAutomaticRunAdmission(runs, work, now, testPolicy),
			await withAutomaticRunAdmission(runs, work, now, testPolicy),
			await withAutomaticRunAdmission(runs, work, now, testPolicy),
		];

		expect(results.filter((result) => result.admitted)).toHaveLength(3);
		expect(dispatches).toBe(3);
	});

	test("leaves due automatic work queued when capacity is occupied", async () => {
		let workStarted = false;
		const result = await withAutomaticRunAdmission(
			{
				async countNonTerminalAutomatic() {
					return 1;
				},
			},
			async () => {
				workStarted = true;
				return "started";
			},
			new Date("2026-06-01T00:00:00.000Z"),
			policy(),
		);

		expect(result).toEqual({ admitted: false });
		expect(workStarted).toBe(false);
	});
});
