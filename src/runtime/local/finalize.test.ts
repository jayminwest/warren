/**
 * `LocalProvider.finalize()` (pl-829f step 12 / warren-371a) — the §4
 * reap-where-the-workspace-is seam. Two concerns:
 *
 *   1. **Delta-shape guarantees** — each mirror delta constructed from realistic
 *      merge outputs survives a `JSON.parse(JSON.stringify(x))` round-trip. The
 *      deltas are the wire format the K8s in-pod finalize emits (step 20), so
 *      serializability is a contract guarantee, not an implementation detail.
 *   2. **Thin-wrapper behavior** — drives the real body against faked
 *      fs/exec/burrow (the SAME reap fakes `src/runs/reap/*.test.ts` use) to
 *      verify stage order, delta assembly from the reap merge functions,
 *      per-stage error capture, empty-push + commits-ahead reporting, and the
 *      missing-clone-hint guard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	openDatabase,
} from "../../runs/reap/test-helpers.ts";
import type { FinalizeIntent, FinalizeResult, RunHandle } from "../contract.ts";
import { RuntimeProviderError } from "../errors.ts";
import { LocalProvider } from "./provider.ts";

const WS = "/data/burrow/ws";
const CLONE = "/data/projects/x/y";
const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

let openDb: WarrenDb | null = null;
afterEach(() => {
	openDb?.close();
	openDb = null;
});

/** A full-tracker workspace + clone seed exercising every merge stage. */
function fullSeed(): Record<string, string> {
	return {
		// mulch: empty clone domain + one incoming workspace record → appended 1.
		[`${WS}/.mulch/expertise/build.jsonl`]:
			'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"a"}\n',
		[`${CLONE}/.mulch/expertise/build.jsonl`]: "",
		// seeds clone baseline (workspace side rides the burrow files.read stub).
		[`${CLONE}/.seeds/issues.jsonl`]:
			'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
	};
}

function intent(overrides: Partial<FinalizeIntent> = {}): FinalizeIntent {
	return {
		branch: "warren/run-1",
		push: true,
		mirror: ["mulch", "seeds", "plans"],
		baseBranch: "main",
		projectClonePathHint: CLONE,
		...overrides,
	};
}

async function provider(opts: {
	fs: ReturnType<typeof fakeFs>;
	exec: ReturnType<typeof fakeExec>;
	seedsIssuesBody?: string;
	seedsPlansBody?: string;
	filesRead?: (burrowId: string, path: string) => Promise<{ contents: string }>;
}): Promise<LocalProvider> {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	const clientOpts: {
		seedsIssuesBody?: string;
		seedsPlansBody?: string;
		filesRead?: (burrowId: string, path: string) => Promise<{ contents: string }>;
	} = {};
	if (opts.seedsIssuesBody !== undefined) clientOpts.seedsIssuesBody = opts.seedsIssuesBody;
	if (opts.seedsPlansBody !== undefined) clientOpts.seedsPlansBody = opts.seedsPlansBody;
	if (opts.filesRead !== undefined) clientOpts.filesRead = opts.filesRead;
	const client = fakeBurrowClient(makeBurrow({ workspacePath: WS }), clientOpts);
	const pool = await makePool(client, repos);
	return new LocalProvider({ burrowClient: () => pool, fs: opts.fs.fs, exec: opts.exec.exec });
}

/* ----------------------------------------------------------------------- */
/* 1. Delta-shape serializability                                           */
/* ----------------------------------------------------------------------- */

describe("finalize delta shapes — JSON round-trip", () => {
	test("the whole FinalizeResult round-trips deep-equal", async () => {
		const fs = fakeFs(fullSeed());
		const exec = fakeExec();
		const p = await provider({
			fs,
			exec,
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
				'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
			seedsPlansBody: '{"id":"pl-1","title":"a plan"}\n',
		});
		const result = await p.finalize(HANDLE, intent());
		const roundTripped: FinalizeResult = JSON.parse(JSON.stringify(result));
		expect(roundTripped).toEqual(result);
	});

	test("each mirror delta is populated and version-tagged", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n',
			seedsPlansBody: '{"id":"pl-1","title":"a plan"}\n',
		});
		const { mirror } = await p.finalize(HANDLE, intent());
		expect(mirror.mulch?.version).toBe(1);
		expect(mirror.seeds?.version).toBe(1);
		expect(mirror.plans?.version).toBe(1);
	});
});

/* ----------------------------------------------------------------------- */
/* 2. Delta assembly from the reap merge functions                          */
/* ----------------------------------------------------------------------- */

describe("finalize — mirror delta assembly", () => {
	test("mulch delta carries LWW counts + per-domain merged body", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const { mirror } = await p.finalize(HANDLE, intent({ mirror: ["mulch"] }));
		expect(mirror.mulch).toEqual({
			version: 1,
			updated: 0,
			skipped: 0,
			appended: 1,
			files: [
				{
					domain: "build",
					path: ".mulch/expertise/build.jsonl",
					mergedBody: '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"a"}\n',
				},
			],
		});
	});

	test("seeds delta carries closed/created counts + merged issues.jsonl", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
				'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
		});
		const { mirror } = await p.finalize(HANDLE, intent({ mirror: ["seeds"] }));
		expect(mirror.seeds?.closed).toBe(1);
		expect(mirror.seeds?.created).toBe(1);
		expect(mirror.seeds?.path).toBe(".seeds/issues.jsonl");
		expect(mirror.seeds?.mergedBody).toContain('"id":"sd-2"');
		expect(mirror.seeds?.mergedBody).toContain('"status":"closed"');
	});

	test("seeds delta mergedBody is null on a no-op mirror (no workspace file)", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() }); // no seedsIssuesBody → 404 → no-op
		const { mirror } = await p.finalize(HANDLE, intent({ mirror: ["seeds"] }));
		expect(mirror.seeds).toEqual({
			version: 1,
			closed: 0,
			created: 0,
			path: ".seeds/issues.jsonl",
			mergedBody: null,
		});
	});

	test("plans delta carries appended count + merged plans.jsonl", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			seedsPlansBody: '{"id":"pl-1","title":"a plan"}\n',
		});
		const { mirror } = await p.finalize(HANDLE, intent({ mirror: ["plans"] }));
		expect(mirror.plans?.appended).toBe(1);
		expect(mirror.plans?.path).toBe(".seeds/plans.jsonl");
		expect(mirror.plans?.mergedBody).toContain('"id":"pl-1"');
	});
});

/* ----------------------------------------------------------------------- */
/* 3. Stage order, push, commits-ahead, empty-push                          */
/* ----------------------------------------------------------------------- */

describe("finalize — stage trail + push reporting", () => {
	test("runs every stage in pipeline order and reports ok", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n',
			seedsPlansBody: '{"id":"pl-1","title":"a plan"}\n',
		});
		const result = await p.finalize(HANDLE, intent());
		expect(result.stages.map((s) => s.stage)).toEqual([
			"mulch_merge",
			"seeds_mirror",
			"plans_mirror",
			"seeds_commit",
			"branch_push",
			"commits_ahead",
		]);
		expect(result.stages.every((s) => s.status === "ok")).toBe(true);
	});

	test("push + commits-ahead: pushed, commitsAhead, prBranch set", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ revListCount: "3" }), seedsPlansBody: "" });
		const result = await p.finalize(HANDLE, intent());
		expect(result.pushed).toBe(true);
		expect(result.commitsAhead).toBe(3);
		expect(result.emptyPush).toBe(false);
		expect(result.prBranch).toBe("warren/run-1");
	});

	test("empty push: zero commits ahead → emptyPush true, prBranch null", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ revListCount: "0" }) });
		const result = await p.finalize(HANDLE, intent());
		expect(result.pushed).toBe(true);
		expect(result.commitsAhead).toBe(0);
		expect(result.emptyPush).toBe(true);
		expect(result.prBranch).toBe(null);
	});

	test("push disabled: branch_push + commits_ahead skipped, commitsAhead null", async () => {
		const fs = fakeFs(fullSeed());
		const exec = fakeExec();
		const p = await provider({ fs, exec });
		const result = await p.finalize(HANDLE, intent({ mirror: [], push: false }));
		expect(result.pushed).toBe(false);
		expect(result.commitsAhead).toBe(null);
		expect(result.prBranch).toBe(null);
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "skipped" },
			{ stage: "commits_ahead", status: "skipped" },
		]);
		expect(exec.calls).toHaveLength(0);
	});

	test("missing baseBranch → commits_ahead skipped, commitsAhead null", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const result = await p.finalize(HANDLE, intent({ mirror: [], baseBranch: undefined }));
		expect(result.pushed).toBe(true);
		expect(result.commitsAhead).toBe(null);
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "ok" },
			{ stage: "commits_ahead", status: "skipped" },
		]);
	});
});

/* ----------------------------------------------------------------------- */
/* 4. Per-stage error capture + guards                                      */
/* ----------------------------------------------------------------------- */

describe("finalize — error capture + guards", () => {
	test("a failing seeds mirror is captured as a failed stage, others proceed", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			// non-NotFound error from files.read → mirrorSeeds re-throws → stage failed.
			filesRead: async () => {
				throw new Error("burrow files.read boom");
			},
		});
		const result = await p.finalize(HANDLE, intent({ mirror: ["seeds"] }));
		const seedsStage = result.stages.find((s) => s.stage === "seeds_mirror");
		expect(seedsStage?.status).toBe("failed");
		expect(seedsStage?.error).toContain("boom");
		// delta still present, zeroed — the domain sees the no-op explicitly.
		expect(result.mirror.seeds).toEqual({
			version: 1,
			closed: 0,
			created: 0,
			path: ".seeds/issues.jsonl",
			mergedBody: null,
		});
		// push still ran after the failed merge.
		expect(result.pushed).toBe(true);
	});

	test("a failing branch push is captured; commits_ahead is skipped", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ fail: "push rejected" }) });
		const result = await p.finalize(HANDLE, intent({ mirror: [] }));
		expect(result.pushed).toBe(false);
		expect(result.commitsAhead).toBe(null);
		expect(result.stages).toEqual([
			{ stage: "branch_push", status: "failed", error: "push rejected" },
			{ stage: "commits_ahead", status: "skipped" },
		]);
	});

	test("non-empty mirror without projectClonePathHint throws RuntimeProviderError", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		await expect(
			p.finalize(HANDLE, intent({ projectClonePathHint: undefined })),
		).rejects.toBeInstanceOf(RuntimeProviderError);
	});

	test("empty mirror needs no clone hint and skips every merge stage", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const result = await p.finalize(
			HANDLE,
			intent({ mirror: [], projectClonePathHint: undefined }),
		);
		expect(result.mirror).toEqual({});
		expect(result.stages.map((s) => s.stage)).toEqual(["branch_push", "commits_ahead"]);
	});
});

/* 5. Collected events (warren-1f56) — for the domain to re-emit */
describe("finalize — collected events", () => {
	test("collects every per-record merge event in pipeline order", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec(),
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
				'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
			seedsPlansBody: '{"id":"pl-1","title":"a plan"}\n',
		});
		const { events } = await p.finalize(HANDLE, intent());
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("mulch.record.added");
		expect(kinds).toContain("seeds.closed");
		expect(kinds).toContain("seeds.created");
		expect(kinds).toContain("seeds.plan_mirrored");
		// mulch (merge) precedes seeds (mirror).
		expect(kinds.indexOf("mulch.record.added")).toBeLessThan(kinds.indexOf("seeds.closed"));
	});

	test("event payloads are JSON-serializable (round-trip deep-equal)", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const { events } = await p.finalize(HANDLE, intent({ mirror: ["mulch"] }));
		const roundTripped = JSON.parse(JSON.stringify(events));
		expect(roundTripped).toEqual(events);
		const added = events.find((e) => e.kind === "mulch.record.added");
		expect(added?.payload).toEqual({ domain: "build", id: "mx-1" });
	});

	test("a failing branch push is collected as a reap_failed event", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ fail: "push rejected" }) });
		const { events } = await p.finalize(HANDLE, intent({ mirror: [] }));
		const failed = events.find((e) => e.kind === "reap_failed");
		expect(failed).toBeDefined();
		expect(failed?.payload).toMatchObject({ step: "branch_push" });
	});

	test("a rev-list failure emits NO reap_failed event (log-only in reap)", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ failRevList: "bad revision" }) });
		const { events } = await p.finalize(HANDLE, intent({ mirror: [] }));
		expect(events.some((e) => e.kind === "reap_failed")).toBe(false);
	});
});

/* 6. dirty probe (warren-1f56) — the domain's droppedCommit signal */
describe("finalize — dirty probe", () => {
	test("zero-commit push + dirty tree → dirty true", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({
			fs,
			exec: fakeExec({ revListCount: "0", gitStatus: " M src/foo.ts\n" }),
		});
		const result = await p.finalize(HANDLE, intent({ mirror: [] }));
		expect(result.commitsAhead).toBe(0);
		expect(result.emptyPush).toBe(true);
		expect(result.dirty).toBe(true);
	});

	test("zero-commit push + clean tree → dirty false", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec({ revListCount: "0" }) });
		const result = await p.finalize(HANDLE, intent({ mirror: [] }));
		expect(result.emptyPush).toBe(true);
		expect(result.dirty).toBe(false);
	});

	test("non-empty push does NOT probe dirtiness (no extra git call)", async () => {
		const fs = fakeFs(fullSeed());
		const exec = fakeExec({ revListCount: "3" });
		const result = await (await provider({ fs, exec })).finalize(HANDLE, intent({ mirror: [] }));
		expect(result.dirty).toBe(false);
		// push + rev-list only — no `git status --porcelain`.
		expect(exec.calls.some((c) => c.args.includes("status"))).toBe(false);
	});
});

/* 7. commit decoupling + workspacePlansBody (warren-1f56) */
describe("finalize — commit decoupling", () => {
	test("mirror:[seeds] commit:[] runs the merge but skips the seeds commit", async () => {
		const fs = fakeFs({
			[`${CLONE}/.seeds/issues.jsonl`]:
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider({
			fs,
			exec,
			seedsIssuesBody:
				'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n',
		});
		const result = await p.finalize(HANDLE, intent({ mirror: ["seeds"], commit: [] }));
		// merge ran → closed count present …
		expect(result.mirror.seeds?.closed).toBe(1);
		// … but no seeds_commit stage and no `git add -- .seeds/`.
		expect(result.stages.map((s) => s.stage)).not.toContain("seeds_commit");
		expect(exec.calls.some((c) => c.args.includes(".seeds/"))).toBe(false);
	});

	test("commit:[seeds] authors the seeds bookkeeping commit", async () => {
		const fs = fakeFs({
			[`${CLONE}/.seeds/issues.jsonl`]:
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const exec = fakeExec({ stagedDelta: true });
		const p = await provider({ fs, exec });
		const result = await p.finalize(
			HANDLE,
			intent({ mirror: ["seeds"], commit: ["seeds"], push: false }),
		);
		expect(result.stages.map((s) => s.stage)).toContain("seeds_commit");
		expect(exec.calls.some((c) => c.cmd === "git" && c.args.includes(".seeds/"))).toBe(true);
	});
});

describe("finalize — workspacePlansBody snapshot", () => {
	test("returns the workspace plans.jsonl captured before the seeds commit", async () => {
		const workspacePlans = '{"id":"pl-new","status":"approved","children":["warren-a"]}\n';
		const fs = fakeFs({
			[`${WS}/.seeds/plans.jsonl`]: workspacePlans,
			[`${CLONE}/.seeds/issues.jsonl`]: "",
			[`${CLONE}/.seeds/plans.jsonl`]: "",
		});
		const p = await provider({ fs, exec: fakeExec({ stagedDelta: true }) });
		const result = await p.finalize(HANDLE, intent({ mirror: ["seeds"], commit: ["seeds"] }));
		expect(result.workspacePlansBody).toBe(workspacePlans);
	});

	test("null when the workspace has no plans.jsonl", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const result = await p.finalize(HANDLE, intent({ mirror: [] }));
		expect(result.workspacePlansBody).toBeNull();
	});
});
