import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { LaunchPreviewInput, LaunchPreviewResult } from "../../preview/launch.ts";
import { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import type { AnnotatePrPreviewInput, AnnotatePrPreviewResult } from "../pr-annotate.ts";
import { reapRun } from "./index.ts";
import {
	BurrowClientPool,
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	fakeOpenPr,
	makeBurrow,
	makePool,
	setup,
} from "./test-helpers.ts";

describe("reapRun preview_launch + pr_annotate_preview (warren-f156)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	const SERVER_PREVIEW: ServerPreviewConfig = {
		type: "server",
		command: "bun run dev",
		port: 3000,
	};

	function fakeLaunch(
		responses: ReadonlyArray<LaunchPreviewResult | (() => LaunchPreviewResult)>,
	): {
		launch: (input: LaunchPreviewInput) => Promise<LaunchPreviewResult>;
		calls: LaunchPreviewInput[];
	} {
		const calls: LaunchPreviewInput[] = [];
		let i = 0;
		const launch = async (input: LaunchPreviewInput): Promise<LaunchPreviewResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeLaunch: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { launch, calls };
	}

	function fakeAnnotate(
		responses: ReadonlyArray<AnnotatePrPreviewResult | (() => AnnotatePrPreviewResult)>,
	): {
		annotate: (input: AnnotatePrPreviewInput) => Promise<AnnotatePrPreviewResult>;
		calls: AnnotatePrPreviewInput[];
	} {
		const calls: AnnotatePrPreviewInput[] = [];
		let i = 0;
		const annotate = async (input: AnnotatePrPreviewInput): Promise<AnnotatePrPreviewResult> => {
			calls.push(input);
			const r = responses[i++];
			if (r === undefined) throw new Error("fakeAnnotate: out of responses");
			return typeof r === "function" ? r() : r;
		};
		return { annotate, calls };
	}

	test("launches preview when outcome=succeeded and project opted in, surfaces live state", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBe("live");
		expect(result.previewPort).toBe(40000);
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.previewConfig.command).toBe("bun run dev");
		// warren-0928: no per-project override → reap omits readinessTimeoutMs
		// so the launcher uses DEFAULT_READINESS_TIMEOUT_MS.
		expect(launch.calls[0]?.readinessTimeoutMs).toBeUndefined();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_launched")).toBeDefined();
	});

	// warren-0928: per-project readiness_timeout flows from .warren/preview.yaml
	// through reap into the launcher as milliseconds. The schema validated the
	// string at load time, so reap parses with parseDurationMs unconditionally.
	test("forwards previewConfig.readiness_timeout as launcher readinessTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, readiness_timeout: "10m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.readinessTimeoutMs).toBe(600_000);
	});

	// warren-d9e7: per-project setup + setup_timeout flow through reap the
	// same way readiness_timeout does — schema validates the duration shape
	// at load time, reap parses to ms before handing off to the launcher.
	test("forwards previewConfig.setup_timeout as launcher setupTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, setup: "pnpm install", setup_timeout: "10m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.previewConfig.setup).toBe("pnpm install");
		expect(launch.calls[0]?.setupTimeoutMs).toBe(600_000);
	});

	test("omits launcher setupTimeoutMs when previewConfig.setup_timeout absent", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, setup: "pnpm install" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls[0]?.setupTimeoutMs).toBeUndefined();
	});

	// warren-9b15: per-project connect_timeout follows the same plumb-through
	// pattern. Phase-1 budget covers sidecar startup + port bind; phase-2
	// budget (readiness_timeout) covers bundler first-compile. Both default
	// when unset so existing projects see no behavior change.
	test("forwards previewConfig.connect_timeout as launcher connectTimeoutMs", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: { ...SERVER_PREVIEW, connect_timeout: "2m" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(1);
		expect(launch.calls[0]?.connectTimeoutMs).toBe(120_000);
	});

	test("omits launcher connectTimeoutMs when previewConfig.connect_timeout absent", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls[0]?.connectTimeoutMs).toBeUndefined();
	});

	test("skips preview launch when project did not opt in (no previewConfig)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBeNull();
		expect(launch.calls).toHaveLength(0);
	});

	test("skips preview launch when outcome=failed (mirrors pr_open conservative gate)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.previewState).toBeNull();
		expect(launch.calls).toHaveLength(0);
	});

	test("emits reap_failed step=preview_launch when launcher returns failure", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([
			{
				ok: false,
				reason: "readiness_timeout",
				message: "no 2xx after 60s",
				failureTail: "TypeError",
				port: 40000,
			},
		]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		// The launcher (real) writes preview_state="failed" before returning;
		// the stub doesn't, but reap captures the state for the result envelope.
		expect(result.previewState).toBe("failed");
		expect(result.previewPort).toBe(40000);
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
		// reap never fails the run on preview launch failure.
		expect(result.state).toBe("succeeded");
	});

	test("preview launch failure does not block reap.completed transition", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([
			() => {
				throw new Error("burrow client exploded");
			},
		]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.state).toBe("succeeded");
		expect(result.previewState).toBe("failed");
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
	});

	test("skips preview launch and emits reap_failed when worker is non-local (R-12 deferral)", async () => {
		// Re-tag the burrow + run to a non-local worker so the gate fires.
		await ctx.repos.workers.upsert({ name: "remote", url: "http://remote:8080" });
		await ctx.repos.burrows.delete("bur_aaaaaaaaaaaa");
		await ctx.repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "remote" });
		await ctx.repos.runs.attachBurrow(ctx.runId, { workerId: "remote" });
		const pool = new BurrowClientPool({ repos: ctx.repos });
		pool.register("remote", fakeBurrowClient(makeBurrow()));
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: pool,
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(launch.calls).toHaveLength(0);
		expect(result.previewState).toBe("failed");
		expect(result.errors.map((e) => e.step)).toContain("preview_launch");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.previewFailureMessage).toContain("R-12");
	});

	test("annotates the PR body with the live preview URL after launch and pr_open succeed", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(result.prUrl).toBe("https://github.com/x/y/pull/77");
		expect(result.previewState).toBe("live");
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toEqual({
			state: "live",
			url: `https://run-${ctx.runId}.warren.example.com`,
		});
		expect(result.previewUrl).toBe(`https://run-${ctx.runId}.warren.example.com`);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_annotated")).toBeDefined();
	});

	test("annotates the PR body with the path-mode preview URL when mode=path (warren-c3c4)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "path" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toEqual({
			state: "live",
			url: `https://warren.example.com/p/${ctx.runId}/`,
		});
		expect(result.previewUrl).toBe(`https://warren.example.com/p/${ctx.runId}/`);
	});

	test("pr_annotate_preview is skipped when no PR was opened", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(0);
	});

	test("pr_annotate_preview is skipped (and reap_failed) when WARREN_PREVIEW_HOST is unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(0);
		expect(result.errors.map((e) => e.step)).toContain("pr_annotate_preview");
		expect(result.state).toBe("succeeded");
	});

	test("pr_annotate_preview still patches a failure tail even with WARREN_PREVIEW_HOST unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([
			{
				ok: false,
				reason: "readiness_timeout",
				message: "no 2xx after 60s",
				failureTail: "TypeError",
				port: 40000,
			},
		]);
		// reap reads previewFailureMessage from the row; the real launcher
		// writes it but our stub doesn't. Pre-seed the row so the
		// annotation step sees the tail.
		await ctx.repos.runs.attachPreview(ctx.runId, {
			previewFailureMessage: "TypeError: cannot read X",
		});
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		expect(annotate.calls).toHaveLength(1);
		expect(annotate.calls[0]?.preview).toMatchObject({
			state: "failed",
			failureTail: "TypeError: cannot read X",
		});
		expect(result.previewUrl).toBeNull();
	});

	test("pr_open includes the preview placeholder fragment when project opted in", async () => {
		const e = fakeExec({ revListCount: "2" });
		const pr = fakeOpenPr([{ ok: true, url: "https://github.com/x/y/pull/77", mode: "created" }]);
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const annotate = fakeAnnotate([{ ok: true, mode: "patched" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, token: "ghp_xyz", warrenBaseUrl: null },
			openPr: pr.openPr,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain" },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
			annotatePrPreview: annotate.annotate,
		});
		const body = pr.calls[0]?.body ?? "";
		expect(body).toContain("<!-- warren:preview-start -->");
		expect(body).toContain("<!-- warren:preview-end -->");
		expect(body).toContain("## Preview");
	});
});
