import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CheckRun, Forge, PullRequestRef, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { createPrMergeChecker } from "../runs/pr-merge.ts";
import { type Harness, NOW, setup } from "./coordinator.test-helpers.ts";
import {
	createMergeStallProbe,
	hasMergeStalledEvent,
	MERGE_STALLED_HINT,
	type MergeStallProbe,
	maybeWarnMergeStalled,
	mergeTimeoutDiagnosis,
} from "./merge-stall.ts";

const REPO_URL = "fake://x/y";

/** One completed, successful check run — the green-CI shape. */
const GREEN_RUN: CheckRun = {
	name: "ci",
	status: "completed",
	conclusion: "success",
	jobId: "job-1",
	detailsUrl: null,
};

interface ProbeFixture {
	forge: FakeForge;
	ref: RepoRef;
	pr: PullRequestRef;
	probe: MergeStallProbe;
}

/** Open one PR on the fake forge and build the probe against it. */
async function openPr(
	forge: FakeForge,
	headBranch = "warren/run-1",
): Promise<{ ref: RepoRef; pr: PullRequestRef }> {
	const ref = forge.parseRepoRef(REPO_URL);
	if (ref === null) throw new Error("fake forge must own the test repo url");
	const result = await forge.openPullRequest(ref, {
		headBranch,
		baseBranch: "main",
		title: "test pr",
		body: "test body",
	});
	if (!result.ok) throw new Error(`openPullRequest failed: ${result.error.detail}`);
	return { ref, pr: result.value };
}

async function fixture(): Promise<ProbeFixture> {
	const forge = new FakeForge();
	const { ref, pr } = await openPr(forge);
	return { forge, ref, pr, probe: createMergeStallProbe({ forge }) };
}

describe("createMergeStallProbe", () => {
	test("reports a green unarmed PR as checksPassing with unarmed auto-merge", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [GREEN_RUN]);
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: true, autoMerge: "unarmed" });
	});

	test("reports pending checks as not passing", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [
			{ ...GREEN_RUN, status: "in_progress", conclusion: null },
		]);
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: false, autoMerge: "unarmed" });
	});

	test("reports failing checks as not passing", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [{ ...GREEN_RUN, conclusion: "failure" }]);
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: false, autoMerge: "unarmed" });
	});

	test("reports an armed PR's auto-merge state verbatim", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [GREEN_RUN]);
		f.forge.setAutoMergeState(f.ref, f.pr, "armed");
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: true, autoMerge: "armed" });
	});

	test("reports an unknown auto-merge state verbatim", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [GREEN_RUN]);
		f.forge.setAutoMergeState(f.ref, f.pr, "unknown");
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: true, autoMerge: "unknown" });
	});

	test("returns null checks when no check runs exist for the head commit", async () => {
		const f = await fixture();
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: null, autoMerge: "unarmed" });
	});

	test("returns null checks when the forge lacks the checkRuns capability", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [GREEN_RUN]);
		const noChecks = Object.create(f.forge) as FakeForge;
		Object.defineProperty(noChecks, "capabilities", {
			value: { ...f.forge.capabilities, checkRuns: false },
		});
		const probe = createMergeStallProbe({ forge: noChecks as unknown as Forge });
		const diagnosis = await probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: null, autoMerge: "unarmed" });
	});

	test("returns nulls for a URL no forge owns", async () => {
		const f = await fixture();
		const diagnosis = await f.probe("https://elsewhere.example/pr/7");
		expect(diagnosis).toEqual({ checksPassing: null, autoMerge: null });
	});

	test("returns nulls for a PR the forge cannot read", async () => {
		const forge = new FakeForge();
		const probe = createMergeStallProbe({ forge });
		const diagnosis = await probe("fake://x/y/pulls/999");
		expect(diagnosis).toEqual({ checksPassing: null, autoMerge: null });
	});

	test("returns nulls for a PR that is no longer open", async () => {
		const f = await fixture();
		f.forge.setChecks(f.ref, "fake-head-warren/run-1", [GREEN_RUN]);
		f.forge.markMerged(f.ref, f.pr);
		const diagnosis = await f.probe(f.pr.webUrl);
		expect(diagnosis).toEqual({ checksPassing: null, autoMerge: null });
	});
});

describe("maybeWarnMergeStalled", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	interface WarnFixture {
		readonly planRunId: string;
		readonly runId: string;
	}

	async function childFixture(): Promise<WarnFixture> {
		const runId = await h.makeRun("warren-a");
		return { planRunId: h.planRun.id, runId };
	}

	function warnInput(
		fx: WarnFixture,
		overrides: Partial<Parameters<typeof maybeWarnMergeStalled>[0]> = {},
	): Parameters<typeof maybeWarnMergeStalled>[0] {
		return {
			planRun: h.planRun,
			child: { seq: 1, seedId: "warren-a" } as Parameters<typeof maybeWarnMergeStalled>[0]["child"],
			runId: fx.runId,
			prUrl: "fake://x/y/pulls/1",
			baseline: NOW.toISOString(),
			probe: async () => ({ checksPassing: true, autoMerge: "unarmed" }),
			warningMs: 5 * 60 * 1000,
			repos: h.repos,
			emit: h.emit,
			now: () => new Date(NOW.getTime() + 6 * 60 * 1000),
			...overrides,
		};
	}

	test("emits the warning once the grace period has elapsed on a green unarmed PR", async () => {
		const fx = await childFixture();
		await maybeWarnMergeStalled(warnInput(fx));
		const event = h.events.find((e) => e.kind === "plan_run.merge_stalled");
		expect(event?.runId).toBe(fx.runId);
		expect(event?.payload).toEqual({
			planRunId: fx.planRunId,
			seq: 1,
			seedId: "warren-a",
			prUrl: "fake://x/y/pulls/1",
			checksPassing: true,
			autoMerge: "unarmed",
			waitedMs: 6 * 60 * 1000,
			hint: MERGE_STALLED_HINT,
		});
	});

	test("does not probe before the grace period has elapsed", async () => {
		const fx = await childFixture();
		let probed = 0;
		const input = warnInput(fx, {
			now: () => new Date(NOW.getTime() + 4 * 60 * 1000),
			probe: async () => {
				probed += 1;
				return { checksPassing: true, autoMerge: "unarmed" };
			},
		});
		await maybeWarnMergeStalled(input);
		expect(probed).toBe(0);
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not probe when the warning is disabled (warningMs 0)", async () => {
		const fx = await childFixture();
		let probed = 0;
		await maybeWarnMergeStalled(
			warnInput(fx, {
				warningMs: 0,
				probe: async () => {
					probed += 1;
					return { checksPassing: true, autoMerge: "unarmed" };
				},
			}),
		);
		expect(probed).toBe(0);
	});

	test("does not emit when no probe is wired", async () => {
		const fx = await childFixture();
		await maybeWarnMergeStalled(warnInput(fx, { probe: undefined }));
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when autoMerge reads unknown", async () => {
		const fx = await childFixture();
		await maybeWarnMergeStalled(
			warnInput(fx, { probe: async () => ({ checksPassing: true, autoMerge: "unknown" }) }),
		);
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when checks are unavailable", async () => {
		const fx = await childFixture();
		await maybeWarnMergeStalled(
			warnInput(fx, { probe: async () => ({ checksPassing: null, autoMerge: "unarmed" }) }),
		);
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when a prior warning is persisted on the run's event stream", async () => {
		const fx = await childFixture();
		const seq = ((await h.repos.events.maxSeqForRun(fx.runId)) ?? 0) + 1;
		await h.repos.events.append({
			runId: fx.runId,
			sandboxEventSeq: seq,
			ts: NOW.toISOString(),
			kind: "plan_run.merge_stalled",
			stream: "system",
			payload: { planRunId: fx.planRunId },
		});
		let probed = 0;
		await maybeWarnMergeStalled(
			warnInput(fx, {
				probe: async () => {
					probed += 1;
					return { checksPassing: true, autoMerge: "unarmed" };
				},
			}),
		);
		expect(probed).toBe(0);
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});
});

describe("hasMergeStalledEvent", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("returns false for a run with no merge-stalled event", async () => {
		const runId = await h.makeRun("warren-a");
		expect(await hasMergeStalledEvent(h.repos, runId)).toBe(false);
	});

	test("returns true once the event is persisted", async () => {
		const runId = await h.makeRun("warren-a");
		const seq = ((await h.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await h.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: NOW.toISOString(),
			kind: "plan_run.merge_stalled",
			stream: "system",
			payload: {},
		});
		expect(await hasMergeStalledEvent(h.repos, runId)).toBe(true);
	});
});

describe("mergeTimeoutDiagnosis", () => {
	test("returns an empty record when no probe is wired", async () => {
		expect(await mergeTimeoutDiagnosis(undefined, "fake://x/y/pulls/1")).toEqual({});
	});

	test("carries the probe's reading into payload fields", async () => {
		const probe: MergeStallProbe = async () => ({ checksPassing: true, autoMerge: "unarmed" });
		expect(await mergeTimeoutDiagnosis(probe, "fake://x/y/pulls/1")).toEqual({
			checksPassing: true,
			autoMerge: "unarmed",
		});
	});
});

describe("createMergeStallProbe — integration with the merge poll target", () => {
	test("resolves the same PR the merge checker polls", async () => {
		const forge = new FakeForge();
		const { ref, pr } = await openPr(forge);
		forge.setChecks(ref, "fake-head-warren/run-1", [GREEN_RUN]);
		const checker = createPrMergeChecker({ forge });
		expect(await checker(pr.webUrl)).toEqual({ kind: "open" });
		const probe = createMergeStallProbe({ forge });
		expect(await probe(pr.webUrl)).toEqual({ checksPassing: true, autoMerge: "unarmed" });
	});
});
