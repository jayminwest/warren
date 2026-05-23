/**
 * Pure-derivation tests for `summarizePlot` (warren-8917 / pl-0344
 * step 15). The IO seam (the underlying reader) is exercised in
 * `reader.test.ts` and scenario 29; here we pin payload shape against
 * a synthetic event log so the wire contract is stable.
 */

import { describe, expect, test } from "bun:test";
import type { Attachment, PlotEvent } from "@os-eco/plot-cli";
import { summarizePlot } from "./summary.ts";

function ev(over: {
	type: string;
	at: string;
	actor?: string;
	data?: Record<string, unknown>;
}): PlotEvent {
	return {
		actor: over.actor ?? "user:alice",
		at: over.at,
		type: over.type,
		data: over.data ?? {},
	} as unknown as PlotEvent;
}

function att(over: Partial<Attachment> & Pick<Attachment, "id" | "type" | "ref">): Attachment {
	return {
		id: over.id,
		type: over.type,
		ref: over.ref,
		role: over.role ?? "tracks",
		added_at: over.added_at ?? "2026-01-02T00:00:00Z",
		added_by: over.added_by ?? "user:alice",
	};
}

describe("summarizePlot", () => {
	test("projects intent identity, created_at, last_event_at, done_at", () => {
		const out = summarizePlot({
			id: "plot-aaa",
			name: "Ship it",
			status: "done",
			project_id: "prj_1",
			intent: { goal: "G", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [
				ev({ type: "plot_created", at: "2026-01-01T00:00:00Z", data: { name: "Ship it" } }),
				ev({
					type: "status_changed",
					at: "2026-01-02T00:00:00Z",
					data: { from: "drafting", to: "ready" },
				}),
				ev({
					type: "status_changed",
					at: "2026-01-05T00:00:00Z",
					data: { from: "active", to: "done" },
				}),
			],
		});
		expect(out.id).toBe("plot-aaa");
		expect(out.project_id).toBe("prj_1");
		expect(out.intent.goal).toBe("G");
		expect(out.created_at).toBe("2026-01-01T00:00:00Z");
		expect(out.last_event_at).toBe("2026-01-05T00:00:00Z");
		expect(out.done_at).toBe("2026-01-05T00:00:00Z");
	});

	test("done_at is null when never transitioned to done", () => {
		const out = summarizePlot({
			id: "plot-b",
			name: "n",
			status: "active",
			project_id: "p",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [
				ev({ type: "plot_created", at: "2026-01-01T00:00:00Z" }),
				ev({
					type: "status_changed",
					at: "2026-01-02T00:00:00Z",
					data: { from: "drafting", to: "ready" },
				}),
			],
		});
		expect(out.done_at).toBeNull();
	});

	test("decisions[] surfaces decision_made events in ascending order with optional rationale", () => {
		const out = summarizePlot({
			id: "p",
			name: "n",
			status: "active",
			project_id: "x",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [
				ev({
					type: "decision_made",
					at: "2026-01-03T00:00:00Z",
					actor: "agent:claude:r_2",
					data: { summary: "use sqlite", rationale: "simpler" },
				}),
				ev({
					type: "decision_made",
					at: "2026-01-02T00:00:00Z",
					actor: "user:alice",
					data: { summary: "scope to V1" },
				}),
				ev({ type: "note", at: "2026-01-04T00:00:00Z", data: { text: "irrelevant" } }),
			],
		});
		expect(out.decisions).toHaveLength(2);
		expect(out.decisions[0]?.summary).toBe("scope to V1");
		expect(out.decisions[0]?.rationale).toBeUndefined();
		expect(out.decisions[1]?.summary).toBe("use sqlite");
		expect(out.decisions[1]?.rationale).toBe("simpler");
		expect(out.decisions[1]?.actor).toBe("agent:claude:r_2");
	});

	test("linked_prs joins gh_pr attachments with pr_merged notes by ref", () => {
		const out = summarizePlot({
			id: "p",
			name: "n",
			status: "done",
			project_id: "x",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [
				att({ id: "att-1", type: "gh_pr", ref: "octocat/repo#7", role: "implements" }),
				att({ id: "att-2", type: "gh_pr", ref: "octocat/repo#9", role: "implements" }),
				att({ id: "att-3", type: "seeds_issue", ref: "warren-1234" }),
			],
			event_log: [
				ev({
					type: "note",
					at: "2026-02-01T00:00:00Z",
					data: { kind: "pr_merged", ref: "octocat/repo#7" },
				}),
			],
		});
		expect(out.linked_prs).toHaveLength(2);
		const pr7 = out.linked_prs.find((p) => p.ref === "octocat/repo#7");
		const pr9 = out.linked_prs.find((p) => p.ref === "octocat/repo#9");
		expect(pr7?.merged_at).toBe("2026-02-01T00:00:00Z");
		expect(pr9?.merged_at).toBeNull();
		expect(out.linked_seeds).toHaveLength(1);
		expect(out.linked_seeds[0]?.ref).toBe("warren-1234");
	});

	test("linked_commits projects artifact_produced events with type=commit", () => {
		const out = summarizePlot({
			id: "p",
			name: "n",
			status: "active",
			project_id: "x",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [
				ev({
					type: "artifact_produced",
					at: "2026-03-01T00:00:00Z",
					data: { type: "commit", ref: "abc123" },
				}),
				ev({
					type: "artifact_produced",
					at: "2026-03-02T00:00:00Z",
					data: { type: "file", ref: "README.md" },
				}),
				ev({
					type: "artifact_produced",
					at: "2026-03-03T00:00:00Z",
					data: { type: "commit", ref: "" }, // dropped
				}),
			],
		});
		expect(out.linked_commits).toHaveLength(1);
		expect(out.linked_commits[0]?.ref).toBe("abc123");
	});

	test("timeline filters to structural events, sorted ascending, with human labels", () => {
		const out = summarizePlot({
			id: "p",
			name: "n",
			status: "active",
			project_id: "x",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
			event_log: [
				ev({
					type: "plot_created",
					at: "2026-01-01T00:00:00Z",
					data: { name: "Demo" },
				}),
				ev({
					type: "intent_edited",
					at: "2026-01-02T00:00:00Z",
					data: { field: "goal", value: "G" },
				}),
				ev({
					type: "status_changed",
					at: "2026-01-03T00:00:00Z",
					data: { from: "drafting", to: "ready" },
				}),
				ev({
					type: "run_dispatched",
					at: "2026-01-04T00:00:00Z",
					data: { run_id: "run_42" },
				}),
				ev({ type: "note", at: "2026-01-05T00:00:00Z", data: { text: "skip" } }),
			],
		});
		const kinds = out.timeline.map((t) => t.kind);
		expect(kinds).toEqual(["plot_created", "status_changed", "run_dispatched"]);
		expect(out.timeline[0]?.label).toContain("Demo");
		expect(out.timeline[1]?.label).toBe("Status: drafting → ready");
		expect(out.timeline[2]?.label).toBe("Run dispatched: run_42");
	});
});
