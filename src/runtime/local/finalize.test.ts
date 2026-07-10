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
		// plot workspace deltas (clone absent → first write).
		[`${WS}/.plot/plot-1.json`]: '{"id":"plot-1","updated_at":"2026-05-17T10:00:00Z"}',
		[`${WS}/.plot/plot-1.events.jsonl`]:
			'{"type":"decision_made","actor":"agent:bot:r1","at":"2026-05-17T10:05:00Z","data":{"summary":"x"}}\n',
	};
}

function intent(overrides: Partial<FinalizeIntent> = {}): FinalizeIntent {
	return {
		branch: "warren/run-1",
		push: true,
		mirror: ["mulch", "seeds", "plans", "plot"],
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
	return new LocalProvider({ burrowClientPool: () => pool, fs: opts.fs.fs, exec: opts.exec.exec });
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
		expect(mirror.plot?.version).toBe(1);
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

	test("plot delta is thin — counts only, no merged bodies", async () => {
		const fs = fakeFs(fullSeed());
		const p = await provider({ fs, exec: fakeExec() });
		const { mirror } = await p.finalize(HANDLE, intent({ mirror: ["plot"] }));
		expect(mirror.plot).toEqual({
			version: 1,
			eventsAppended: 1,
			plotsUpdated: 1,
			mirrored: 1,
		});
		// contract guarantee: the thin plot delta carries no file bodies.
		expect(Object.keys(mirror.plot ?? {})).toEqual([
			"version",
			"eventsAppended",
			"plotsUpdated",
			"mirrored",
		]);
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
			"plot_merge",
			"plot_commit",
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
