import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_PLAN_RUN_MERGE_STALLED_WARNING_MS,
	DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS,
	DEFAULT_PLAN_RUN_TICK_MS,
	loadPlanRunCoordinatorConfigFromEnv,
} from "./config.ts";

describe("loadPlanRunCoordinatorConfigFromEnv", () => {
	test("defaults when env unset", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({});
		expect(config.tickMs).toBe(DEFAULT_PLAN_RUN_TICK_MS);
		expect(config.disabled).toBe(false);
		expect(config.mergeTimeoutMs).toBe(DEFAULT_PLAN_RUN_MERGE_TIMEOUT_MS);
		expect(config.mergeStallWarningMs).toBe(DEFAULT_PLAN_RUN_MERGE_STALLED_WARNING_MS);
	});

	test("WARREN_PLAN_RUN_DISABLED honors the standard truthy set", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				true,
			);
		}
	});

	test("WARREN_PLAN_RUN_DISABLED treats falsy strings as not-disabled", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", ""]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("WARREN_PLAN_RUN_DISABLED treats out-of-set values as not-disabled", () => {
		for (const v of ["2", "enabled", "disable", "garbage"]) {
			expect(loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("parses WARREN_PLAN_RUN_MERGE_TIMEOUT_MS", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "60000",
		});
		expect(config.mergeTimeoutMs).toBe(60000);
	});

	test("merge timeout of 0 disables the bound", () => {
		const config = loadPlanRunCoordinatorConfigFromEnv({
			WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "0",
		});
		expect(config.mergeTimeoutMs).toBe(0);
	});

	test("rejects negative merge timeout", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "-1" }),
		).toThrow(ValidationError);
	});

	test("rejects non-numeric merge timeout", () => {
		expect(() =>
			loadPlanRunCoordinatorConfigFromEnv({ WARREN_PLAN_RUN_MERGE_TIMEOUT_MS: "soon" }),
		).toThrow(ValidationError);
	});

	describe("WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS (pl-92a3 step 7)", () => {
		test("defaults to five minutes when env unset", () => {
			expect(DEFAULT_PLAN_RUN_MERGE_STALLED_WARNING_MS).toBe(5 * 60 * 1000);
			expect(loadPlanRunCoordinatorConfigFromEnv({}).mergeStallWarningMs).toBe(
				DEFAULT_PLAN_RUN_MERGE_STALLED_WARNING_MS,
			);
		});

		test("parses an explicit value", () => {
			const config = loadPlanRunCoordinatorConfigFromEnv({
				WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS: "60000",
			});
			expect(config.mergeStallWarningMs).toBe(60000);
		});

		test("stall warning of 0 disables the warning", () => {
			const config = loadPlanRunCoordinatorConfigFromEnv({
				WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS: "0",
			});
			expect(config.mergeStallWarningMs).toBe(0);
		});

		test("rejects a negative value", () => {
			expect(() =>
				loadPlanRunCoordinatorConfigFromEnv({
					WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS: "-1",
				}),
			).toThrow(ValidationError);
		});

		test("rejects a non-numeric value", () => {
			expect(() =>
				loadPlanRunCoordinatorConfigFromEnv({
					WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS: "soon",
				}),
			).toThrow(ValidationError);
		});
	});
});
