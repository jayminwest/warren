import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_SCHEDULER_TICK_MS,
	DEFAULT_SD_BINARY,
	loadTriggerSchedulerConfigFromEnv,
} from "./config.ts";

describe("loadTriggerSchedulerConfigFromEnv", () => {
	test("returns defaults when env is empty", () => {
		const cfg = loadTriggerSchedulerConfigFromEnv({});
		expect(cfg.tickMs).toBe(DEFAULT_SCHEDULER_TICK_MS);
		expect(cfg.disabled).toBe(false);
		expect(cfg.sdBinary).toBe(DEFAULT_SD_BINARY);
	});

	test("WARREN_SCHEDULER_TICK_MS overrides the tick interval", () => {
		const cfg = loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_TICK_MS: "5000" });
		expect(cfg.tickMs).toBe(5000);
	});

	test("rejects non-positive or non-numeric tick values", () => {
		expect(() => loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_TICK_MS: "0" })).toThrow(
			ValidationError,
		);
		expect(() => loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_TICK_MS: "-5" })).toThrow(
			ValidationError,
		);
		expect(() =>
			loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_TICK_MS: "notanumber" }),
		).toThrow(ValidationError);
	});

	test("WARREN_SCHEDULER_DISABLED honors the standard truthy set", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
			expect(loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_DISABLED: v }).disabled).toBe(
				true,
			);
		}
	});

	test("WARREN_SCHEDULER_DISABLED treats falsy strings as not-disabled", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", ""]) {
			expect(loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("WARREN_SCHEDULER_DISABLED treats out-of-set values as not-disabled", () => {
		for (const v of ["2", "enabled", "disable", "garbage"]) {
			expect(loadTriggerSchedulerConfigFromEnv({ WARREN_SCHEDULER_DISABLED: v }).disabled).toBe(
				false,
			);
		}
	});

	test("WARREN_SD_BINARY overrides the seeds binary", () => {
		const cfg = loadTriggerSchedulerConfigFromEnv({ WARREN_SD_BINARY: "/usr/local/bin/sd" });
		expect(cfg.sdBinary).toBe("/usr/local/bin/sd");
	});

	test("empty WARREN_SD_BINARY rejects with a recovery hint", () => {
		expect(() => loadTriggerSchedulerConfigFromEnv({ WARREN_SD_BINARY: "" })).toThrow(
			ValidationError,
		);
	});
});
