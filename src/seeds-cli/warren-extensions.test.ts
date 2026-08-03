import { describe, expect, test } from "bun:test";
import { RUN_TRIGGER_KINDS } from "../core/wire.ts";
import { WarrenExtensionsSchema, WarrenTriggerKind } from "./warren-extensions.ts";

describe("WarrenTriggerKind", () => {
	test("accepts the canonical trigger set (derived from RUN_TRIGGER_KINDS)", () => {
		for (const kind of RUN_TRIGGER_KINDS) {
			expect(WarrenTriggerKind.safeParse(kind).success).toBe(true);
		}
	});

	// warren-c486: `manual-trigger` is a legacy raw column value, normalized to
	// `manual` by `normalizeRunTriggerKind` before it reaches this schema.
	test("rejects strings outside the enum (e.g. manual-trigger)", () => {
		expect(WarrenTriggerKind.safeParse("manual-trigger").success).toBe(false);
		expect(WarrenTriggerKind.safeParse("Manual").success).toBe(false);
		expect(WarrenTriggerKind.safeParse("").success).toBe(false);
	});
});

describe("WarrenExtensionsSchema", () => {
	test("parses the post-manual-dispatch shape", () => {
		const parsed = WarrenExtensionsSchema.safeParse({
			role: "claude-code",
			trigger: "manual",
			lastRunId: "run_abc",
			lastRunAt: "2026-05-15T15:30:00.000Z",
		});
		expect(parsed.success).toBe(true);
	});

	test("parses the post-cron-dispatch shape (clears scheduledFor)", () => {
		const parsed = WarrenExtensionsSchema.safeParse({
			role: "claude-code",
			trigger: "cron",
			lastRunId: "run_abc",
			lastRunAt: "2026-05-15T15:30:00.000Z",
			scheduledFor: null,
			lastScheduledRun: "run_abc",
		});
		expect(parsed.success).toBe(true);
	});

	test("allows partial updates (every key optional)", () => {
		const parsed = WarrenExtensionsSchema.safeParse({ lastRunId: "run_xyz" });
		expect(parsed.success).toBe(true);
	});

	test("allows scheduledFor: null (clear) and a string value", () => {
		expect(WarrenExtensionsSchema.safeParse({ scheduledFor: null }).success).toBe(true);
		expect(
			WarrenExtensionsSchema.safeParse({
				scheduledFor: "2026-05-15T20:00:00.000Z",
			}).success,
		).toBe(true);
	});

	test("rejects an invalid trigger value", () => {
		const parsed = WarrenExtensionsSchema.safeParse({ trigger: "manual-trigger" });
		expect(parsed.success).toBe(false);
	});

	test("rejects unknown keys (strict)", () => {
		const parsed = WarrenExtensionsSchema.safeParse({
			role: "claude-code",
			somethingElse: "nope",
		} as unknown);
		expect(parsed.success).toBe(false);
	});

	test("rejects empty-string role / lastRunId / lastRunAt", () => {
		expect(WarrenExtensionsSchema.safeParse({ role: "" }).success).toBe(false);
		expect(WarrenExtensionsSchema.safeParse({ lastRunId: "" }).success).toBe(false);
		expect(WarrenExtensionsSchema.safeParse({ lastRunAt: "" }).success).toBe(false);
	});
});
