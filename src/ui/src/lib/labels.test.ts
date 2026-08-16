import { describe, expect, test } from "bun:test";
// Relative import, not the `@/` alias — this file runs under the repo-root
// `bun test`, which resolves no `@/` (see use-capabilities.helpers.ts).
import { RUN_FAILURE_REASONS } from "../../../core/wire.ts";
import {
	formatChildStateCounts,
	formatPlanRunFailureReason,
	formatRunFailureReason,
	humanizeWireValue,
} from "./labels.ts";

/**
 * Warren's dashboard is public, so the guarantee under test is narrow and
 * absolute: nothing these helpers return may still look like a wire enum
 * (warren-14fc / #641). The exhaustiveness case walks the canonical
 * `RUN_FAILURE_REASONS` tuple from `src/core/wire.ts` rather than a local
 * copy, so a reason added to the kernel without a label fails here.
 */

describe("humanizeWireValue", () => {
	test("capitalises the first word and spaces the rest", () => {
		expect(humanizeWireValue("no_model_response")).toBe("No model response");
	});

	test("upper-cases the pr acronym in any position", () => {
		expect(humanizeWireValue("pr_open")).toBe("PR open");
		expect(humanizeWireValue("pr_closed_without_merge")).toBe("PR closed without merge");
	});

	test("survives degenerate input", () => {
		expect(humanizeWireValue("")).toBe("");
		expect(humanizeWireValue("___")).toBe("___");
		expect(humanizeWireValue("crashed")).toBe("Crashed");
		expect(humanizeWireValue("__none__")).toBe("None");
	});
});

describe("formatRunFailureReason", () => {
	test("maps every canonical reason to prose", () => {
		for (const reason of RUN_FAILURE_REASONS) {
			const label = formatRunFailureReason(reason);
			expect(label).not.toContain("_");
			expect(label).not.toBe(reason);
		}
	});

	test("uses the curated wording, not a mechanical de-underscore", () => {
		expect(formatRunFailureReason("finalize_failed")).toBe("Finalize failed");
		expect(formatRunFailureReason("finalize_unposted")).toBe("Finalize not posted");
		expect(formatRunFailureReason("oom_killed")).toBe("Out of memory");
		expect(formatRunFailureReason("sandbox_run_lost")).toBe("Sandbox run lost");
	});

	test("falls back to humanized prose for an unmapped reason", () => {
		expect(formatRunFailureReason("some_future_reason")).toBe("Some future reason");
	});
});

describe("formatPlanRunFailureReason", () => {
	test("humanizes a bare discriminator", () => {
		expect(formatPlanRunFailureReason("pr_closed_without_merge")).toBe("PR closed without merge");
		expect(formatPlanRunFailureReason("parent_pr_merge_timeout")).toBe("Parent PR merge timeout");
	});

	test("keeps the free-text detail verbatim in parentheses", () => {
		expect(formatPlanRunFailureReason("child_seed_not_found:warren-a")).toBe(
			"Child seed not found (warren-a)",
		);
		expect(formatPlanRunFailureReason("dispatch_failed:burrow unreachable")).toBe(
			"Dispatch failed (burrow unreachable)",
		);
	});

	test("drops an empty detail rather than rendering empty parentheses", () => {
		expect(formatPlanRunFailureReason("dispatch_failed:")).toBe("Dispatch failed");
		expect(formatPlanRunFailureReason("dispatch_failed:   ")).toBe("Dispatch failed");
	});
});

describe("formatChildStateCounts", () => {
	test("renders an em-dash with no children", () => {
		expect(formatChildStateCounts([])).toEqual({ text: "—", title: "No child seeds yet" });
	});

	test("spells out only the non-empty buckets", () => {
		const summary = formatChildStateCounts([
			{ state: "pending" },
			{ state: "pending" },
			{ state: "merged" },
			{ state: "failed" },
		]);
		expect(summary.text).toBe("2 pending · 1 merged · 1 failed");
		expect(summary.title).toBe(
			"4 child seeds: 2 pending, 0 in flight, 1 merged, 0 skipped, 1 failed",
		);
	});

	test("folds dispatched, running and pr_open into one in-flight bucket", () => {
		const summary = formatChildStateCounts([
			{ state: "dispatched" },
			{ state: "running" },
			{ state: "pr_open" },
		]);
		expect(summary.text).toBe("3 in flight");
	});

	test("counts skipped separately from merged", () => {
		const summary = formatChildStateCounts([{ state: "merged" }, { state: "skipped" }]);
		expect(summary.text).toBe("1 merged · 1 skipped");
	});

	test("singularises the tooltip for one child", () => {
		expect(formatChildStateCounts([{ state: "running" }]).title).toBe(
			"1 child seed: 0 pending, 1 in flight, 0 merged, 0 skipped, 0 failed",
		);
	});
});
