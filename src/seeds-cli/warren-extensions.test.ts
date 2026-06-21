import { describe, expect, test } from "bun:test";
import { readTargetRepo, WarrenExtensionsSchema, WarrenTriggerKind } from "./warren-extensions.ts";

describe("WarrenTriggerKind", () => {
	test("accepts the canonical trigger set", () => {
		for (const kind of ["manual", "cron", "scheduled", "webhook", "comment", "cli"] as const) {
			expect(WarrenTriggerKind.safeParse(kind).success).toBe(true);
		}
	});

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

	test("parses a slug repo pointer", () => {
		expect(WarrenExtensionsSchema.safeParse({ repo: "warren" }).success).toBe(true);
	});

	test("parses a git remote URL repo pointer", () => {
		expect(
			WarrenExtensionsSchema.safeParse({ repo: "https://github.com/os-eco/warren.git" }).success,
		).toBe(true);
	});

	test("allows the repo key to be absent", () => {
		expect(WarrenExtensionsSchema.safeParse({ role: "claude-code" }).success).toBe(true);
	});

	test("rejects an empty-string repo pointer", () => {
		expect(WarrenExtensionsSchema.safeParse({ repo: "" }).success).toBe(false);
	});
});

describe("readTargetRepo", () => {
	test("returns a present slug repo pointer", () => {
		expect(readTargetRepo({ repo: "child-repo" })).toBe("child-repo");
	});

	test("returns a present git remote URL repo pointer", () => {
		expect(readTargetRepo({ repo: "git@github.com:os-eco/warren.git" })).toBe(
			"git@github.com:os-eco/warren.git",
		);
	});

	test("trims surrounding whitespace", () => {
		expect(readTargetRepo({ repo: "  child-repo  " })).toBe("child-repo");
	});

	test("returns undefined when the repo key is absent", () => {
		expect(readTargetRepo({ role: "claude-code" })).toBeUndefined();
	});

	test("returns undefined for an empty / whitespace-only string", () => {
		expect(readTargetRepo({ repo: "" })).toBeUndefined();
		expect(readTargetRepo({ repo: "   " })).toBeUndefined();
	});

	test("returns undefined for a non-string repo value", () => {
		expect(readTargetRepo({ repo: 42 } as unknown as Record<string, unknown>)).toBeUndefined();
	});

	test("returns undefined for absent / null extensions", () => {
		expect(readTargetRepo(undefined)).toBeUndefined();
		expect(readTargetRepo(null)).toBeUndefined();
	});
});
