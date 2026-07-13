import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	FinalizeIntent,
	FinalizeResult,
	RunHandle,
	RuntimeProvider,
	WorkspaceInfo,
} from "../../runtime/contract.ts";
import { reapRun } from "./index.ts";
import {
	type Burrow,
	BurrowClient,
	type Ctx,
	fakeExec,
	fakeFs,
	makePool,
	setup,
} from "./test-helpers.ts";

/**
 * Leg 1 (warren-e9e1): a succeeded run under a K8s-style provider (no host
 * workspace) must reach `provider.finalize()` — branch push, mirror deltas, PR —
 * even though `burrows.get` 404s on a pod name. reap resolves the workspace via
 * `provider.workspaceInfo()` (path null, branch from the pod annotation), never a
 * direct burrow lookup.
 */

interface FakeProvider {
	provider: RuntimeProvider;
	calls: {
		workspaceInfo: number;
		finalize: number;
		terminate: number;
		lastIntent: FinalizeIntent | null;
	};
}

/** A K8s-shaped provider: workspaceInfo returns a null host path + a branch. */
function fakeK8sProvider(opts: {
	branch: string | null;
	finalizeResult: FinalizeResult;
}): FakeProvider {
	const calls = {
		workspaceInfo: 0,
		finalize: 0,
		terminate: 0,
		lastIntent: null as FinalizeIntent | null,
	};
	const provider = {
		capabilities: {
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: false,
			midRunSteering: false,
			enforcedResourceLimits: true,
			workspaceArchive: false,
		},
		workspaceInfo: async (_h: RunHandle): Promise<WorkspaceInfo> => {
			calls.workspaceInfo += 1;
			return { workspacePath: null, branch: opts.branch };
		},
		finalize: async (_h: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> => {
			calls.finalize += 1;
			calls.lastIntent = intent;
			return opts.finalizeResult;
		},
		terminate: async () => {
			calls.terminate += 1;
			return { archived: true, deletedEvents: 0, deletedMessages: 0, deletedRuns: 0 };
		},
	} as unknown as RuntimeProvider;
	return { provider, calls };
}

/** A burrow client whose `burrows.get` ALWAYS throws — proves no dependency. */
function throwingBurrowClient(): BurrowClient {
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	});
	(client.http.burrows as unknown as { get: () => Promise<Burrow> }).get = async () => {
		throw new Error("burrows.get must not be called under the K8s provider");
	};
	return client;
}

function finalizeResultWithDeltas(branch: string): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 3,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "mulch.record.added", payload: { id: "mx-1" } }],
		mirror: {
			mulch: {
				version: 1,
				updated: 1,
				skipped: 0,
				appended: 0,
				files: [
					{
						domain: "build",
						path: ".mulch/expertise/build.jsonl",
						mergedBody: '{"id":"mx-1","content":"merged"}\n',
					},
				],
			},
			seeds: {
				version: 1,
				closed: 1,
				created: 0,
				path: ".seeds/issues.jsonl",
				mergedBody: '{"id":"warren-1","status":"closed"}\n',
			},
		},
		prBranch: branch,
		stages: [{ stage: "branch_push", status: "ok" }],
	};
}

describe("reapRun under a K8s-style RuntimeProvider", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("succeeded run reaches finalize (no burrows.get dependency) and pushes", async () => {
		const branch = "warren/run-1";
		const fake = fakeK8sProvider({ branch, finalizeResult: finalizeResultWithDeltas(branch) });
		const e = fakeExec({ stagedDelta: true }); // clone-apply sees a real staged delta

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			// A throwing burrow client: reaching finalize despite it proves reap no
			// longer depends on burrows.get under the provider seam.
			burrowClient: await makePool(throwingBurrowClient(), ctx.repos),
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.state).toBe("succeeded");
		expect(fake.calls.workspaceInfo).toBe(1);
		expect(fake.calls.finalize).toBe(1);
		expect(fake.calls.terminate).toBe(1);
		// The finalize intent carried the branch resolved from workspaceInfo.
		expect(fake.calls.lastIntent?.branch).toBe(branch);
		// finalize's push result flowed through to the reap result.
		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(3);
		// finalize's per-record events were re-emitted on reap's real surface.
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "mulch.record.added")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("applies finalize mirror deltas to the project clone (leg 2)", async () => {
		const branch = "warren/run-1";
		const fake = fakeK8sProvider({ branch, finalizeResult: finalizeResultWithDeltas(branch) });
		const f = fakeFs();
		const e = fakeExec({ stagedDelta: true });

		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: await makePool(throwingBurrowClient(), ctx.repos),
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		// Merged bodies were written into the project clone.
		expect(f.files.get("/data/projects/x/y/.mulch/expertise/build.jsonl")).toContain(
			'"content":"merged"',
		);
		expect(f.files.get("/data/projects/x/y/.seeds/issues.jsonl")).toContain('"status":"closed"');

		// The clone commit was authored by the canonical warren bot identity, in
		// the clone working dir (not a workspace).
		const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
		expect(commit).toBeDefined();
		expect(commit?.args).toContain("user.name=warren");
		expect(commit?.args).toContain("user.email=warren@os-eco.dev");
		expect(commit?.args).toContain("chore(warren): mirror state");
		expect(commit?.cwd).toBe("/data/projects/x/y");

		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap.clone_deltas_applied")).toBe(true);
	});

	test("workspaceInfo throwing skips the pipeline and records workspace_lookup", async () => {
		const provider = {
			capabilities: {},
			workspaceInfo: async () => {
				throw new Error("pod list failed");
			},
		} as unknown as RuntimeProvider;
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClient: await makePool(throwingBurrowClient(), ctx.repos),
			runtimeProvider: provider,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.errors.map((x) => x.step)).toContain("workspace_lookup");
		expect(result.branchPushed).toBe(false);
		// No pipeline git work ran.
		expect(e.calls).toHaveLength(0);
		// The run still terminalizes.
		expect(result.state).toBe("succeeded");
	});
});
