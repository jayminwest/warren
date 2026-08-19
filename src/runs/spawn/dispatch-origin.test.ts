import { describe, expect, test } from "bun:test";
import { DISPATCH_ORIGINS, type DispatchOrigin } from "./types.ts";

/**
 * Closed-vocabulary lock for the dispatch-context provenance surface
 * (warren-9ce3 / pl-a37b Track A). warren-d6ca will persist these values;
 * a silent rename here would corrupt the log.
 */
describe("DISPATCH_ORIGINS (warren-9ce3)", () => {
	test("exposes the exact closed vocabulary the issue specifies", () => {
		expect([...DISPATCH_ORIGINS]).toEqual([
			"api",
			"cli",
			"cron",
			"scheduled",
			"manual_trigger",
			"ci_fixer",
			"healer",
			"plan_run",
			"retry_infra_lost",
			"retry_provider",
		]);
	});

	test("DispatchOrigin narrows to the tuple members", () => {
		const sample: DispatchOrigin = "api";
		expect(DISPATCH_ORIGINS.includes(sample)).toBe(true);
	});
});
