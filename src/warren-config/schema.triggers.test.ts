import { describe, expect, test } from "bun:test";
import { VALID_TRIGGER } from "./schema.test-helpers.ts";
import { parseTriggersConfig, TriggersConfigSchema } from "./schema.ts";

describe("TriggersConfigSchema", () => {
	test("accepts an array of cron triggers", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER]);
		expect(parsed.success).toBe(true);
	});

	test("accepts the optional 6-field cron form (seconds first)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "0 0 3 * * *" }]);
		expect(parsed.success).toBe(true);
	});

	test("accepts a cron trigger without seed (seedless agent)", () => {
		const { seed: _, ...seedless } = VALID_TRIGGER;
		const parsed = TriggersConfigSchema.safeParse([seedless]);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data[0]?.seed).toBeUndefined();
		}
	});

	test("accepts an optional positive maxCostUsd spend cap", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, maxCostUsd: 5 }]);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data[0]?.maxCostUsd).toBe(5);
		}
	});

	test("rejects a non-positive maxCostUsd", () => {
		const zero = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, maxCostUsd: 0 }]);
		expect(zero.success).toBe(false);
		const negative = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, maxCostUsd: -1 }]);
		expect(negative.success).toBe(false);
	});

	test("rejects unknown kinds (preserves room for future webhook triggers)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, kind: "webhook" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects strict-extra fields so typos surface loudly", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, oops: 1 }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects malformed cron expressions", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "every minute" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects duplicate trigger ids", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER, VALID_TRIGGER]);
		expect(parsed.success).toBe(false);
	});

	test("rejects ids that aren't kebab/snake-case", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, id: "Nightly Job" }]);
		expect(parsed.success).toBe(false);
	});
});

describe("parseTriggersConfig", () => {
	test("treats null/undefined as an empty trigger list", () => {
		expect(parseTriggersConfig(null)).toEqual({ ok: true, value: [] });
		expect(parseTriggersConfig(undefined)).toEqual({ ok: true, value: [] });
	});

	test("returns ok=true with parsed entries on success", () => {
		const result = parseTriggersConfig([VALID_TRIGGER]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.id).toBe("nightly-refactor");
		}
	});

	test("returns ok=false with a joined message on failure (no throw)", () => {
		const result = parseTriggersConfig([{ ...VALID_TRIGGER, cron: "" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/cron/);
		}
	});
});
