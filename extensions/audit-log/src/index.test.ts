import { describe, expect, test } from "bun:test";
import { EXTENSION_NAME, EXTENSION_VERSION, resolveConfig } from "./index.ts";

describe("resolveConfig", () => {
	test("accepts the full environment contract", () => {
		const resolved = resolveConfig({
			WARREN_BASE_URL: "https://warren.example.com",
			WARREN_API_TOKEN: "tok",
		});
		expect(resolved).toEqual({
			ok: true,
			config: {
				warrenBaseUrl: "https://warren.example.com",
				warrenApiToken: "tok",
			},
		});
	});

	test("names every missing variable at once", () => {
		expect(resolveConfig({})).toEqual({
			ok: false,
			missing: ["WARREN_BASE_URL", "WARREN_API_TOKEN"],
		});
	});

	test("treats empty strings as missing", () => {
		const resolved = resolveConfig({ WARREN_BASE_URL: "", WARREN_API_TOKEN: "tok" });
		expect(resolved.ok).toBe(false);
	});
});

describe("the scaffold", () => {
	test("ships a name and a pre-release version", () => {
		expect(EXTENSION_NAME).toBe("audit-log");
		expect(EXTENSION_VERSION).toBe("0.0.0");
	});
});
