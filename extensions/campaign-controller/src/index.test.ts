import { describe, expect, test } from "bun:test";
import {
	CampaignControllerError,
	EXTENSION_NAME,
	EXTENSION_VERSION,
	FixedClock,
	isCampaignControllerError,
} from "./index.ts";

describe("campaign-controller entrypoint", () => {
	test("exposes the package identity and the shared primitives", () => {
		expect(EXTENSION_NAME).toBe("campaign-controller");
		expect(EXTENSION_VERSION).toBe("0.0.0");
		expect(new FixedClock(5).nowMs()).toBe(5);
		expect(isCampaignControllerError(new CampaignControllerError("not_implemented", "x"))).toBe(
			true,
		);
	});

	test("the package imports nothing from warren src/ or scripts/", async () => {
		// Regression half of the extensions seam (scripts/check-layers.ts):
		// read the entrypoint source back and prove no forbidden specifier is
		// present. The repo-level layer guard walks the whole package; this
		// keeps the proof standing inside the standalone test suite.
		const indexSource = await Bun.file(new URL("./index.ts", import.meta.url).pathname).text();
		expect(indexSource.includes('"../../src/')).toBe(false);
		expect(indexSource.includes("warren/src/")).toBe(false);
		expect(indexSource.includes('from "../')).toBe(false);
	});
});
