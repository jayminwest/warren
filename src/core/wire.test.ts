import { describe, expect, test } from "bun:test";
import {
	FORGE_ERROR_KINDS,
	isActivePreviewState,
	isForgeErrorKind,
	isKnownRuntimeId,
	isPullRequestLifecycle,
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
	PULL_REQUEST_LIFECYCLES,
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

	test("failure reasons include no_changes for ref-dispatch zero-commit (warren-ba08)", () => {
		expect(RUN_FAILURE_REASONS).toContain("no_changes");
	});

	/**
	 * Drift #2 (warren-b229): the UI still typed `mode: "batch" |
	 * "interactive"` after warren-d622 / warren-ee27 deleted the value.
	 */
	test("batch is the only surviving run mode", () => {
		expect([...RUN_MODES]).toEqual(["batch"]);
	});
});

// warren-0993 / forge-contract.md §2.1: the pull-request lifecycle and the
// forge error taxonomy land in the house shape (frozen tuple + derived union
// + membership guard) so the UI and SDK re-export, never re-list.
describe("pull-request vocabulary", () => {
	test("PULL_REQUEST_LIFECYCLES lists exactly the forge-reported states", () => {
		expect([...PULL_REQUEST_LIFECYCLES]).toEqual(["open", "merged", "closed_unmerged"]);
	});

	test("isPullRequestLifecycle accepts members and rejects everything else", () => {
		for (const s of PULL_REQUEST_LIFECYCLES) expect(isPullRequestLifecycle(s)).toBe(true);
		expect(isPullRequestLifecycle("closed")).toBe(false);
		expect(isPullRequestLifecycle("")).toBe(false);
		expect(isPullRequestLifecycle(undefined)).toBe(false);
		expect(isPullRequestLifecycle(7)).toBe(false);
	});
});

describe("forge error vocabulary", () => {
	test("FORGE_ERROR_KINDS lists all ten arms of the taxonomy", () => {
		expect([...FORGE_ERROR_KINDS]).toEqual([
			"no_credential",
			"unauthorized",
			"forbidden",
			"not_found",
			"conflict",
			"rate_limited",
			"push_protected",
			"unsupported",
			"network",
			"http_error",
		]);
	});

	test("isForgeErrorKind accepts members and rejects everything else", () => {
		for (const k of FORGE_ERROR_KINDS) expect(isForgeErrorKind(k)).toBe(true);
		expect(isForgeErrorKind("timeout")).toBe(false);
		expect(isForgeErrorKind("")).toBe(false);
		expect(isForgeErrorKind(undefined)).toBe(false);
		expect(isForgeErrorKind(null)).toBe(false);
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
		expect([...KNOWN_RUNTIME_IDS]).toEqual(["claude-code", "pi"]);
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
