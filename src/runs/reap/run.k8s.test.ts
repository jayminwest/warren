import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { LaunchPreviewInput, LaunchPreviewResult } from "../../preview/launch/index.ts";
import { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	RunHandle,
	RuntimeProvider,
	WorkspaceInfo,
} from "../../runtime/contract.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import { reapRun } from "./index.ts";
import { type Ctx, fakeExec, fakeFs, fakeOpenPr, setup } from "./test-helpers.ts";

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

function finalizeResultWithDeltas(branch: string): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 3,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [{ kind: "mulch.record.added", payload: { id: "mx-1" } }],
		artifacts: {
			mulch: {
				version: 1,
				files: [
					{
						path: ".mulch/expertise/build.jsonl",
						mergedBody: '{"id":"mx-1","content":"merged"}\n',
					},
				],
				counts: { updated: 1, skipped: 0, appended: 0 },
			},
			seeds: {
				version: 1,
				files: [
					{ path: ".seeds/issues.jsonl", mergedBody: '{"id":"warren-1","status":"closed"}\n' },
				],
				counts: { closed: 1, created: 0 },
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

	// warren-4fbe: preview launch is a LocalProvider-only capability (it exposes
	// an inbound port through the burrow worker). Under a provider that advertises
	// previewPorts=false, the step must skip cleanly — never touch the launcher,
	// never fail the run — and surface a `reap.preview_skipped_unsupported` event.
	test("skips preview launch when provider lacks previewPorts, without touching the launcher", async () => {
		const branch = "warren/run-1";
		const fake = fakeK8sProvider({ branch, finalizeResult: finalizeResultWithDeltas(branch) });
		const e = fakeExec({ stagedDelta: true });
		const preview: ServerPreviewConfig = { type: "server", command: "bun run dev", port: 3000 };
		const launchCalls: LaunchPreviewInput[] = [];
		const launchPreview = async (input: LaunchPreviewInput): Promise<LaunchPreviewResult> => {
			launchCalls.push(input);
			return { ok: true, port: 40000, sidecarId: "sc_1" };
		};

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: preview,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview,
		});

		// The run still succeeds and the launcher was never called.
		expect(result.state).toBe("succeeded");
		expect(launchCalls).toHaveLength(0);
		// Preview outcome degrades to the same shape a non-opted-in project produces.
		expect(result.previewState).toBeNull();
		expect(result.previewPort).toBeNull();
		expect(result.previewUrl).toBeNull();
		// No preview launch failure was recorded.
		expect(result.errors.map((x) => x.step)).not.toContain("preview_launch");
		// The skip is surfaced as a structured event.
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap.preview_skipped_unsupported")).toBe(true);
	});

	test("stays silent about preview when provider lacks previewPorts and project did not opt in", async () => {
		const branch = "warren/run-1";
		const fake = fakeK8sProvider({ branch, finalizeResult: finalizeResultWithDeltas(branch) });
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.previewState).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap.preview_skipped_unsupported")).toBe(false);
	});

	test("pr_open fetches the pushed branch into the clone to rebuild PR sections (warren-ab66)", async () => {
		const branch = "warren/run-1";
		const fake = fakeK8sProvider({ branch, finalizeResult: finalizeResultWithDeltas(branch) });
		const e = fakeExec({ stagedDelta: true });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/9", mode: "created" }]);

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
		});

		expect(result.prUrl).toBe("https://github.com/x/y/pull/9");
		// The context-gathering fetched the pushed run branch into the project
		// clone under a namespaced temp ref (never a local branch), cwd = the clone.
		const fetchCall = e.calls.find(
			(c) =>
				c.cmd === "git" &&
				c.args[0] === "fetch" &&
				c.args.some((a) => a.includes("refs/warren/pr-open/")),
		);
		expect(fetchCall).toBeDefined();
		expect(fetchCall?.cwd).toBe(ctx.projectPath);
		// The temp ref is torn down after the reads.
		const cleanup = e.calls.find(
			(c) => c.cmd === "git" && c.args[0] === "update-ref" && c.args.includes("-d"),
		);
		expect(cleanup).toBeDefined();
	});

	// warren-495d: the in-pod finalize timed out / the pod vanished before it
	// posted a result, so K8sProvider.finalize returns a structured FAILED result
	// with every stage failed and `pushed:false`. reap must (1) NOT report the run
	// succeeded, (2) preserve the workspace (never call terminate), and (3) not
	// close the run's seed.
	test("finalize timeout before branch_push fails the run and preserves the workspace (warren-495d)", async () => {
		const branch = "warren/run-1";
		const message = "in-pod finalize timed out after 120000ms";
		const timedOut: FinalizeResult = {
			pushed: false,
			commitsAhead: null,
			emptyPush: false,
			dirty: false,
			workspacePlansBody: null,
			events: [{ kind: "reap_failed", payload: { step: "finalize", message } }],
			artifacts: {},
			prBranch: null,
			stages: [
				{ stage: "mulch_merge", status: "failed", error: message },
				{ stage: "seeds_mirror", status: "failed", error: message },
				{ stage: "plans_mirror", status: "failed", error: message },
				{ stage: "branch_push", status: "failed", error: message },
			],
		};
		const fake = fakeK8sProvider({ branch, finalizeResult: timedOut });
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		// (1) not succeeded — a distinct finalize_failed terminal reason.
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("finalize_failed");
		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("branch_push");
		// (2) workspace preserved — terminate never ran.
		expect(fake.calls.terminate).toBe(0);
		expect(result.workspaceDestroyed).toBe(false);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const skipped = events.find((ev) => ev.kind === "reap.workspace_destroy_skipped");
		expect(skipped?.payloadJson).toMatchObject({ reason: "branch_push_failed" });
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
