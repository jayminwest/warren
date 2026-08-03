import { describe, expect, test } from "bun:test";
import { DEFAULT_HEALER_ROLE, HealerConfigSchema } from "./feature-loop-config.ts";

describe("HealerConfigSchema", () => {
	test("defaults role and projectMapping when the block is minimal", () => {
		const parsed = HealerConfigSchema.parse({ enabled: true });
		expect(parsed.role).toBe(DEFAULT_HEALER_ROLE);
		expect(parsed.projectMapping).toEqual([]);
	});

	test("accepts exact and wildcard mapping keys", () => {
		const parsed = HealerConfigSchema.parse({
			enabled: true,
			projectMapping: ["fp-1234", "src/runs/*", "*ErrorRate", "*"],
		});
		expect(parsed.projectMapping.length).toBe(4);
	});

	// warren-50a7: matching is anchored, so a padded key would silently never
	// match. Reject it at config load instead.
	test("rejects a mapping key with leading/trailing whitespace", () => {
		const parsed = HealerConfigSchema.safeParse({ enabled: true, projectMapping: [" api "] });
		expect(parsed.success).toBe(false);
	});

	test("rejects an empty mapping key", () => {
		expect(HealerConfigSchema.safeParse({ enabled: true, projectMapping: [""] }).success).toBe(
			false,
		);
	});
});
