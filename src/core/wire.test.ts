import { describe, expect, test } from "bun:test";
import {
	isActivePreviewState,
	isKnownRuntimeId,
	isRunTriggerKind,
	isTerminalPlanRunChildState,
	isTerminalPlanRunState,
	isTerminalRunState,
	KNOWN_RUNTIME_IDS,
	LEGACY_RUN_TRIGGER_ALIASES,
	normalizeRunTriggerKind,
	PLAN_RUN_ACTIVE_STATES,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_CHILD_TERMINAL_STATES,
	PLAN_RUN_STATES,
	PLAN_RUN_TERMINAL_STATES,
	PREVIEW_ACTIVE_STATES,
	PREVIEW_STATES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
	RUN_TERMINAL_STATES,
	RUN_TRIGGER_KINDS,
} from "./wire.ts";

describe("run vocabulary", () => {
	test("terminal states are a subset of the run states", () => {
		for (const s of RUN_TERMINAL_STATES) {
			expect(RUN_STATES).toContain(s);
		}
	});

	test("isTerminalRunState splits terminal from in-flight", () => {
		for (const s of RUN_STATES) {
			expect(isTerminalRunState(s)).toBe((RUN_TERMINAL_STATES as readonly string[]).includes(s));
		}
	});

	/**
	 * Drift #1 (warren-b229): both the SDK and the UI carried a 9-value
	 * `RunFailureReason` while reap and the K8s run-state probe were already
	 * persisting these two, so two real failure modes were unrepresentable
	 * on the wire.
	 */
	test("failure reasons include the two the copies had lost", () => {
		expect(RUN_FAILURE_REASONS).toContain("finalize_failed");
		expect(RUN_FAILURE_REASONS).toContain("evicted");
	});

	/**
	 * Drift #2 (warren-b229): the UI still typed `mode: "batch" |
	 * "interactive"` after warren-d622 / warren-ee27 deleted the value.
	 */
	test("batch is the only surviving run mode", () => {
		expect([...RUN_MODES]).toEqual(["batch"]);
	});
});

describe("preview vocabulary", () => {
	test("isActivePreviewState flags only the port-holding states", () => {
		for (const s of PREVIEW_STATES) {
			expect(isActivePreviewState(s)).toBe(
				(PREVIEW_ACTIVE_STATES as readonly string[]).includes(s),
			);
		}
		expect([...PREVIEW_ACTIVE_STATES]).toEqual(["starting", "live"]);
	});
});

describe("plan-run vocabulary", () => {
	test("terminal and active plan-run states partition the enum", () => {
		const partitioned = [...PLAN_RUN_TERMINAL_STATES, ...PLAN_RUN_ACTIVE_STATES].sort();
		expect(partitioned).toEqual([...PLAN_RUN_STATES].sort());
	});

	test("isTerminalPlanRunState splits terminal from in-flight", () => {
		for (const s of PLAN_RUN_STATES) {
			expect(isTerminalPlanRunState(s)).toBe(
				(PLAN_RUN_TERMINAL_STATES as readonly string[]).includes(s),
			);
		}
	});

	test("isTerminalPlanRunChildState splits terminal from in-flight", () => {
		for (const s of PLAN_RUN_CHILD_STATES) {
			expect(isTerminalPlanRunChildState(s)).toBe(
				(PLAN_RUN_CHILD_TERMINAL_STATES as readonly string[]).includes(s),
			);
		}
	});
});

// warren-c4be: the runtime-id vocabulary is canonical here because both the
// per-project config schema and the agent registry validate against it.
describe("runtime id vocabulary", () => {
	test("KNOWN_RUNTIME_IDS lists the burrow runtimes warren dispatches onto", () => {
		expect([...KNOWN_RUNTIME_IDS]).toEqual(["claude-code", "sapling", "pi"]);
	});

	test("isKnownRuntimeId accepts members and rejects everything else", () => {
		for (const id of KNOWN_RUNTIME_IDS) expect(isKnownRuntimeId(id)).toBe(true);
		expect(isKnownRuntimeId("planner")).toBe(false);
		expect(isKnownRuntimeId("")).toBe(false);
		expect(isKnownRuntimeId(undefined)).toBe(false);
		expect(isKnownRuntimeId(7)).toBe(false);
	});
});

// warren-c486: the trigger-kind vocabulary is canonical here so the spawn-side
// seed-extension writer and the seeds-CLI zod schema share one list.
describe("run trigger vocabulary", () => {
	test("RUN_TRIGGER_KINDS covers every kind a live dispatcher passes", () => {
		for (const kind of [
			"manual",
			"cron",
			"scheduled",
			"webhook",
			"comment",
			"cli",
			"plan-run",
			"auto_plan_run",
			"ci-fixer",
			"healer",
		]) {
			expect(isRunTriggerKind(kind)).toBe(true);
			expect((RUN_TRIGGER_KINDS as readonly string[]).includes(kind)).toBe(true);
		}
	});

	test("isRunTriggerKind rejects non-members", () => {
		expect(isRunTriggerKind("manual-trigger")).toBe(false);
		expect(isRunTriggerKind("")).toBe(false);
		expect(isRunTriggerKind(undefined)).toBe(false);
	});

	test("normalizeRunTriggerKind maps the legacy manual-trigger alias to manual", () => {
		expect(normalizeRunTriggerKind("manual-trigger")).toBe("manual");
		for (const alias of Object.keys(LEGACY_RUN_TRIGGER_ALIASES)) {
			expect(normalizeRunTriggerKind(alias)).not.toBeUndefined();
		}
	});

	test("normalizeRunTriggerKind returns undefined for an unknown or absent value", () => {
		expect(normalizeRunTriggerKind("totally-made-up")).toBeUndefined();
		expect(normalizeRunTriggerKind(undefined)).toBeUndefined();
	});
});
