/**
 * Unit tests for the pure needs-attention scorer
 * (warren-d693 / pl-0344 step 9).
 */

import { describe, expect, test } from "bun:test";
import type { PlotEvent } from "@os-eco/plot-cli";
import {
	computeNeedsAttentionReasons,
	DEFAULT_STALE_DRAFT_DAYS,
	NEEDS_ATTENTION_REASONS,
	type NeedsAttentionInputs,
} from "./needs-attention.ts";
import type { PlotSummary } from "./types.ts";

function summary(over: Partial<PlotSummary> = {}): PlotSummary {
	return {
		id: "plot-test",
		name: "t",
		status: "active",
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: "2026-05-20T00:00:00Z",
		last_event_actor: "user:a",
		project_id: "prj_a",
		...over,
	};
}

function inputs(over: Partial<NeedsAttentionInputs>): NeedsAttentionInputs {
	return {
		plot: summary(),
		events: [],
		hasPausedRun: false,
		now: new Date("2026-05-22T00:00:00Z"),
		...over,
	};
}

describe("computeNeedsAttentionReasons", () => {
	test("returns [] for an idle non-draft Plot with no paused runs and no PRs", () => {
		expect(computeNeedsAttentionReasons(inputs({}))).toEqual([]);
	});

	test("returns ['paused_run'] when hasPausedRun is true", () => {
		const r = computeNeedsAttentionReasons(inputs({ hasPausedRun: true }));
		expect(r).toEqual(["paused_run"]);
	});

	test("stale_draft requires status=drafting AND age > threshold", () => {
		// Drafting but fresh: not stale.
		expect(
			computeNeedsAttentionReasons(
				inputs({
					plot: summary({ status: "drafting", last_event_ts: "2026-05-21T00:00:00Z" }),
				}),
			),
		).toEqual([]);
		// Drafting AND old: stale.
		expect(
			computeNeedsAttentionReasons(
				inputs({
					plot: summary({ status: "drafting", last_event_ts: "2026-04-01T00:00:00Z" }),
				}),
			),
		).toEqual(["stale_draft"]);
		// Old but not drafting: not stale.
		expect(
			computeNeedsAttentionReasons(
				inputs({
					plot: summary({ status: "active", last_event_ts: "2026-04-01T00:00:00Z" }),
				}),
			),
		).toEqual([]);
	});

	test("staleDraftAfterDays override controls the window", () => {
		// 2 days old, 1-day threshold ⇒ stale.
		const r1 = computeNeedsAttentionReasons(
			inputs({
				plot: summary({ status: "drafting", last_event_ts: "2026-05-20T00:00:00Z" }),
				staleDraftAfterDays: 1,
			}),
		);
		expect(r1).toEqual(["stale_draft"]);
		// 2 days old, 30-day threshold ⇒ fresh.
		const r2 = computeNeedsAttentionReasons(
			inputs({
				plot: summary({ status: "drafting", last_event_ts: "2026-05-20T00:00:00Z" }),
				staleDraftAfterDays: 30,
			}),
		);
		expect(r2).toEqual([]);
	});

	test("merged_pr_unreviewed fires for an artifact_produced gh_pr with no follow-up review", () => {
		const events: PlotEvent[] = [
			{
				type: "artifact_produced",
				actor: "agent:x",
				at: "2026-05-20T00:00:00Z",
				data: { type: "gh_pr", ref: "owner/repo#42" },
			},
		];
		expect(computeNeedsAttentionReasons(inputs({ events }))).toEqual(["merged_pr_unreviewed"]);
	});

	test("merged_pr_unreviewed clears when a decision_made or note references the ref", () => {
		const base: PlotEvent[] = [
			{
				type: "artifact_produced",
				actor: "agent:x",
				at: "2026-05-20T00:00:00Z",
				data: { type: "gh_pr", ref: "owner/repo#42" },
			},
		];
		const decided: PlotEvent[] = [
			...base,
			{
				type: "decision_made",
				actor: "user:operator",
				at: "2026-05-21T00:00:00Z",
				data: { summary: "owner/repo#42 looks good, ship it" },
			},
		];
		expect(computeNeedsAttentionReasons(inputs({ events: decided }))).toEqual([]);
		const noted: PlotEvent[] = [
			...base,
			{
				type: "note",
				actor: "user:operator",
				at: "2026-05-21T00:00:00Z",
				data: { text: "Reviewed owner/repo#42." },
			},
		];
		expect(computeNeedsAttentionReasons(inputs({ events: noted }))).toEqual([]);
	});

	test("ignores artifact_produced events whose type is not gh_pr", () => {
		const events: PlotEvent[] = [
			{
				type: "artifact_produced",
				actor: "agent:x",
				at: "2026-05-20T00:00:00Z",
				data: { type: "seeds_issue", ref: "warren-abc1" },
			},
		];
		expect(computeNeedsAttentionReasons(inputs({ events }))).toEqual([]);
	});

	test("multiple signals come back in canonical order", () => {
		const events: PlotEvent[] = [
			{
				type: "artifact_produced",
				actor: "agent:x",
				at: "2026-05-20T00:00:00Z",
				data: { type: "gh_pr", ref: "owner/repo#1" },
			},
		];
		const r = computeNeedsAttentionReasons(
			inputs({
				plot: summary({ status: "drafting", last_event_ts: "2026-04-01T00:00:00Z" }),
				events,
				hasPausedRun: true,
			}),
		);
		expect(r).toEqual(["paused_run", "merged_pr_unreviewed", "stale_draft"]);
	});

	test("invalid last_event_ts does not fire stale_draft", () => {
		expect(
			computeNeedsAttentionReasons(
				inputs({
					plot: summary({ status: "drafting", last_event_ts: "not-a-date" }),
				}),
			),
		).toEqual([]);
	});

	test("constants are exported as expected", () => {
		expect(DEFAULT_STALE_DRAFT_DAYS).toBe(7);
		expect(NEEDS_ATTENTION_REASONS).toEqual(["paused_run", "merged_pr_unreviewed", "stale_draft"]);
	});
});
