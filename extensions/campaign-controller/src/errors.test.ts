import { describe, expect, test } from "bun:test";
import {
	BoundaryError,
	CampaignControllerError,
	type CampaignControllerErrorCode,
	ConfigError,
	isCampaignControllerError,
	StateError,
	ValidationError,
} from "./errors.ts";

describe("error base types", () => {
	test("every subclass is a CampaignControllerError carrying its stable code", () => {
		const cases: Array<[CampaignControllerError, CampaignControllerErrorCode]> = [
			[new ValidationError("bad manifest"), "input_invalid"],
			[new ConfigError("missing token"), "config_invalid"],
			[new StateError("journal gap"), "state_invalid"],
			[new BoundaryError("would mutate GitHub"), "boundary_violated"],
			[new CampaignControllerError("not_implemented", "nothing here"), "not_implemented"],
		];
		for (const [error, code] of cases) {
			expect(error).toBeInstanceOf(CampaignControllerError);
			expect(error.code).toBe(code);
			expect(error.message.length).toBeGreaterThan(0);
		}
	});

	test("isCampaignControllerError narrows unknown at catch sites", () => {
		expect(isCampaignControllerError(new StateError("x"))).toBe(true);
		expect(isCampaignControllerError(new Error("plain"))).toBe(false);
		expect(isCampaignControllerError("string")).toBe(false);
	});

	test("toJson exposes a machine-readable envelope without extra fields", () => {
		const error = new BoundaryError("would post a pull request");
		expect(error.toJson()).toEqual({
			error: "BoundaryError",
			code: "boundary_violated",
			message: "would post a pull request",
		});
	});

	test("cause propagates through the base constructor", () => {
		const cause = new Error("socket");
		const error = new ConfigError("warren unreachable", { cause });
		expect(error.cause).toBe(cause);
	});
});
