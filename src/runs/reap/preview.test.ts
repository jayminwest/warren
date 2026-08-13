import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { LaunchPreviewInput, LaunchPreviewResult } from "../../preview/launch/index.ts";
import { PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
	stubForge,
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

	test("launches preview when outcome=succeeded and project opted in, surfaces live state", async () => {
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
		// Re-tag the run to a non-local worker so the gate fires. worker_id is no
		// longer written by dispatch (warren-3743), but the column is retained and
		// the preview gate still reads it, so a direct attach exercises the path.
		await ctx.repos.runs.attachBurrow(ctx.runId, { workerId: "remote" });
		const e = fakeExec({ revListCount: "2" });
		const launch = fakeLaunch([]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
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
		const forge = fakeForge();
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain", port: null },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect(result.previewState).toBe("live");
		expect(result.previewUrl).toBe(`https://run-${ctx.runId}.warren.example.com`);
		// The forge store carries the patched body — the semantic seam's truth.
		const body = forge.store.getPr("x/y", 1)?.body ?? "";
		expect(body).toContain(`https://run-${ctx.runId}.warren.example.com`);
		expect(body).not.toContain("Preview launching…");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const annotated = events.find((ev) => ev.kind === "preview_annotated");
		expect(annotated?.payloadJson).toMatchObject({ mode: "patched", state: "live" });
	});

	test("annotates the PR body with the path-mode preview URL when mode=path (warren-c3c4)", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "path", port: 8081 },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		// warren-3f8a: path-mode previews live on the dedicated listener's port.
		expect(result.previewUrl).toBe(`https://warren.example.com:8081/p/${ctx.runId}/`);
		const body = forge.store.getPr("x/y", 1)?.body ?? "";
		expect(body).toContain(`https://warren.example.com:8081/p/${ctx.runId}/`);
	});

	test("pr_annotate_preview is skipped when no PR was opened", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain", port: null },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		expect(forge.store.getPr("x/y", 1)).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_annotated")).toBeUndefined();
	});

	test("pr_annotate_preview reports a skipped sub-step when the forge cannot edit bodies (§5)", async () => {
		const e = fakeExec({ revListCount: "2" });
		// §5: a forge without pullRequestBodyEdit makes the degradation VISIBLE.
		const base = fakeForge();
		const forge = stubForge({
			capabilities: { ...base.capabilities, pullRequestBodyEdit: false },
			openPullRequest: (ref, req) => base.openPullRequest(ref, req),
			findPullRequest: (ref, q) => base.findPullRequest(ref, q),
		});
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: "warren.example.com", mode: "subdomain", port: null },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		// The PR still opened; the body keeps its placeholder, and reap succeeds.
		expect(result.prUrl).toBe("fake://x/y/pulls/1");
		expect(result.state).toBe("succeeded");
		expect(result.previewUrl).toBeNull();
		expect(base.store.getPr("x/y", 1)?.body).toContain("<!-- warren:preview-start -->");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const skipped = events.find((ev) => ev.kind === "reap.pr_annotate_preview_skipped");
		expect(skipped?.payloadJson).toMatchObject({
			reason: "forge_capability",
			capability: "pullRequestBodyEdit",
		});
		expect(events.find((ev) => ev.kind === "preview_annotated")).toBeUndefined();
	});

	test("pr_annotate_preview is skipped (and reap_failed) when WARREN_PREVIEW_HOST is unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		const launch = fakeLaunch([{ ok: true, port: 40000, sidecarId: "sc_1" }]);
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain", port: null },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		// The body keeps its placeholder — no patch without a URL to publish.
		expect(forge.store.getPr("x/y", 1)?.body).toContain("<!-- warren:preview-start -->");
		expect(result.errors.map((e) => e.step)).toContain("pr_annotate_preview");
		expect(result.state).toBe("succeeded");
	});

	test("pr_annotate_preview still patches a failure tail even with WARREN_PREVIEW_HOST unset", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
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
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
			previewLaunchConfig: { host: null, mode: "subdomain", port: null },
			portAllocator: new PreviewPortAllocator(DrizzleAdapter.for(ctx.db)),
			launchPreview: launch.launch,
		});
		const body = forge.store.getPr("x/y", 1)?.body ?? "";
		expect(body).toContain("Preview failed");
		expect(body).toContain("TypeError: cannot read X");
		expect(result.previewUrl).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "preview_annotated")?.payloadJson).toMatchObject({
			mode: "patched",
			state: "failed",
		});
	});

	test("pr_open includes the preview placeholder fragment when project opted in", async () => {
		const e = fakeExec({ revListCount: "2" });
		const forge = fakeForge();
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
			autoOpenPr: { enabled: true, warrenBaseUrl: null },
			forge,
			previewConfig: SERVER_PREVIEW,
		});
		const body = forge.store.getPr("x/y", 1)?.body ?? "";
		expect(body).toContain("<!-- warren:preview-start -->");
		expect(body).toContain("<!-- warren:preview-end -->");
		expect(body).toContain("## Preview");
	});
});
