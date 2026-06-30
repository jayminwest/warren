import { describe, expect, test } from "bun:test";
import { dispatchAutoPlanRuns } from "./auto-plan-run.ts";

/* Direct unit tests for dispatchAutoPlanRuns (warren-c40e).               */
/* The integration path through reapRun is covered in auto-plan-run.test.ts. */
/* ----------------------------------------------------------------------- */

describe("dispatchAutoPlanRuns (warren-c40e)", () => {
	const run = { id: "run-1", plotId: null, renderedAgentJson: {}, agentName: "patrol-bot" };
	const project = { id: "proj-1", defaultBranch: "main", localPath: "/data/projects/x/y" };
	const emit = async () => undefined;
	const fail = async () => undefined;

	function makePlanRuns(created: { planId?: string }[]) {
		return {
			create: async (input: unknown) => {
				created.push(input as { planId?: string });
				return { planRun: { id: "pr-1" } };
			},
		};
	}

	test("dispatches a new plan when workspace size equals baseline size (detects by ID, not size)", async () => {
		// baseline=[pl-old] workspace=[pl-new]: equal counts (1 == 1), but
		// pl-new is a genuinely new plan. The old set-size early-exit dropped
		// it; detection must be by ID, not by size.
		const created: { planId?: string }[] = [];
		const result = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds: new Set(["pl-new"]),
			baselinePlanIds: new Set(["pl-old"]),
			workspacePlansBody: '{"id":"pl-new","status":"approved","children":["warren-c1"]}\n',
			planRuns: makePlanRuns(created),
			emit,
			fail,
		});

		expect(result.created).toBe(true);
		expect(result.planId).toBe("pl-new");
		expect(result.id).toBe("pr-1");
		expect(created).toHaveLength(1);
		expect(created[0]?.planId).toBe("pl-new");
	});

	test("does not dispatch when every workspace plan is already in the baseline (ID match)", async () => {
		const created: { planId?: string }[] = [];
		const result = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds: new Set(["pl-old"]),
			baselinePlanIds: new Set(["pl-old"]),
			workspacePlansBody: '{"id":"pl-old","status":"approved","children":["warren-c1"]}\n',
			planRuns: makePlanRuns(created),
			emit,
			fail,
		});

		expect(result.created).toBe(false);
		expect(result.id).toBeNull();
		expect(result.planId).toBeNull();
		expect(created).toHaveLength(0);
	});

	test("returns a no-op when plan ids or body are null (early-exit)", async () => {
		const created: { planId?: string }[] = [];
		const planRuns = makePlanRuns(created);
		const body = '{"id":"pl-new","status":"approved","children":["warren-c1"]}\n';

		const nullWorkspace = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds: null,
			baselinePlanIds: new Set(["pl-old"]),
			workspacePlansBody: body,
			planRuns,
			emit,
			fail,
		});
		const nullBaseline = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds: new Set(["pl-new"]),
			baselinePlanIds: null,
			workspacePlansBody: body,
			planRuns,
			emit,
			fail,
		});
		const nullBody = await dispatchAutoPlanRuns({
			run,
			project,
			workspacePlanIds: new Set(["pl-new"]),
			baselinePlanIds: new Set(["pl-old"]),
			workspacePlansBody: null,
			planRuns,
			emit,
			fail,
		});

		for (const result of [nullWorkspace, nullBaseline, nullBody]) {
			expect(result.created).toBe(false);
			expect(result.id).toBeNull();
			expect(result.planId).toBeNull();
		}
		expect(created).toHaveLength(0);
	});
});
