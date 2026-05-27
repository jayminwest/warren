import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import { PreviewPortAllocator } from "../port-allocator.ts";
import { launchPreview } from "./orchestrate.ts";
import {
	alwaysConnected,
	fakeFetch,
	fakeSidecars,
	type LaunchTestEnv,
	PREVIEW_CONFIG,
	setupLaunchEnv,
} from "./test-helpers.ts";
import {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	PROBE_PER_CALL_TIMEOUT_MS,
} from "./types.ts";

describe("launchPreview", () => {
	let db: WarrenDb;
	let repos: Repos;
	let allocator: PreviewPortAllocator;
	let runId: string;
	let burrowId: string;

	beforeEach(async () => {
		const env: LaunchTestEnv = await setupLaunchEnv();
		db = env.db;
		repos = env.repos;
		allocator = env.allocator;
		runId = env.runId;
		burrowId = env.burrowId;
	});

	afterEach(async () => {
		await db.close();
	});

	test("allocates a port, spawns the sidecar, marks live on 2xx readiness", async () => {
		const sidecars = fakeSidecars();
		const { fetch, calls } = fakeFetch([new Response("ok", { status: 200 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async () => {},
			now: () => new Date("2026-05-14T18:00:00.000Z"),
		});
		expect(result).toEqual({ ok: true, port: 40000, sidecarId: "sc_test_1" });
		expect(sidecars.creates).toHaveLength(1);
		const created = sidecars.creates[0];
		expect(created?.command).toEqual(["sh", "-c", "bun run dev"]);
		expect(created?.env).toEqual({ HOST: "0.0.0.0", HOSTNAME: "0.0.0.0", PORT: "3000" });
		expect(created?.inboundPortForward).toEqual({ hostPort: 40000, sandboxPort: 3000 });
		expect(calls[0]).toBe("http://127.0.0.1:40000/");
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("live");
		expect(row.previewPort).toBe(40000);
		expect(row.previewFailureMessage).toBeNull();
	});

	// warren-79b2: dev servers (Next.js 13.5+, http.createServer() defaults)
	// that bind to 127.0.0.1 only are unreachable from burrow's inbound
	// forwarder. Inject HOST/HOSTNAME=0.0.0.0 + PORT=<sandbox port> on every
	// preview sidecar so CRA / Express-style servers default to "reachable",
	// and so frameworks that read process.env.PORT don't need the operator to
	// duplicate the port number in their command.
	test("injects HOST/HOSTNAME/PORT into the sidecar env, PORT matches previewConfig.port", async () => {
		const sidecars = fakeSidecars();
		const { fetch } = fakeFetch([new Response("ok", { status: 200 })]);
		const config: ServerPreviewConfig = { ...PREVIEW_CONFIG, port: 5173 };
		await launchPreview({
			runId,
			burrowId,
			previewConfig: config,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async () => {},
		});
		expect(sidecars.creates[0]?.env).toEqual({
			HOST: "0.0.0.0",
			HOSTNAME: "0.0.0.0",
			PORT: "5173",
		});
	});

	test("honors readiness_path when supplied", async () => {
		const sidecars = fakeSidecars();
		const { fetch, calls } = fakeFetch([new Response("ok", { status: 200 })]);
		const config: ServerPreviewConfig = { ...PREVIEW_CONFIG, readiness_path: "/healthz" };
		await launchPreview({
			runId,
			burrowId,
			previewConfig: config,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async () => {},
		});
		expect(calls[0]).toBe("http://127.0.0.1:40000/healthz");
		expect(sidecars.creates[0]?.readinessPath).toBe("/healthz");
	});

	test("treats 3xx as ready (dev servers redirect / to /index)", async () => {
		const sidecars = fakeSidecars();
		const { fetch } = fakeFetch([new Response(null, { status: 302 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async () => {},
		});
		expect(result.ok).toBe(true);
	});

	test("returns port_exhausted when the allocator has no free ports", async () => {
		// Pre-fill both ports in the tiny 40000-40001 range.
		const tinyAllocator = new PreviewPortAllocator(DrizzleAdapter.for(db), {
			start: 40000,
			end: 40001,
		});
		const occupant1 = await repos.runs.create({
			agentName: "agent",
			projectId: (await repos.projects.listAll())[0]?.id as string,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		const occupant2 = await repos.runs.create({
			agentName: "agent",
			projectId: (await repos.projects.listAll())[0]?.id as string,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await repos.runs.attachPreview(occupant1.id, { previewState: "live", previewPort: 40000 });
		await repos.runs.attachPreview(occupant2.id, { previewState: "live", previewPort: 40001 });

		const sidecars = fakeSidecars();
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator: tinyAllocator,
			sidecars: sidecars.client,
			fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
			sleep: async () => {},
		});
		expect(result).toEqual({
			ok: false,
			reason: "port_exhausted",
			message: expect.stringContaining("port_exhausted"),
			failureTail: "",
			port: null,
		});
		expect(sidecars.creates).toHaveLength(0);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewFailureMessage).toContain("port_exhausted");
	});

	test("returns create_failed when burrow sidecar spawn throws", async () => {
		const sidecars = fakeSidecars();
		sidecars.createImpl = async () => {
			throw new Error("sandbox spawn refused");
		};
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
			sleep: async () => {},
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("create_failed");
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
		expect(row.previewFailureMessage).toContain("sandbox spawn refused");
	});

	test("returns readiness_timeout, captures stderr tail, deletes the sidecar", async () => {
		const sidecars = fakeSidecars({ stdout: "compiling…\n", stderr: "TypeError: cannot read X\n" });
		// Step the clock so we can fire the timeout deterministically.
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks * 1000);
		const { fetch } = fakeFetch([
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
		]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async () => {
				ticks += 5;
			},
			now,
			readinessTimeoutMs: 2_000,
			readinessPollMs: 100,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("readiness_timeout");
		expect((result as { failureTail: string }).failureTail).toContain("TypeError");
		expect(sidecars.deletes).toHaveLength(1);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
		expect(row.previewFailureMessage).toContain("readiness probe");
		expect(row.previewFailureMessage).toContain("TypeError");
	});

	// warren-fdf2: bumped from 5m to 10m after run_428nktsej0yh confirmed
	// modern SPA first-compile (Next.js 14, ~1875 modules) routinely
	// approaches 7-8 minutes wall clock — the 5m default was sized when
	// install + bind shared the budget, but warren-d9e7 split install into
	// its own setup sidecar so this constant now sizes bundler cold-start.
	test("DEFAULT_READINESS_TIMEOUT_MS is 10 minutes", () => {
		expect(DEFAULT_READINESS_TIMEOUT_MS).toBe(600_000);
	});

	test("respects injected readinessTimeoutMs over the default deadline", async () => {
		// Hold the clock fixed and feed enough 502s to exhaust the override
		// (10ms / 100ms poll = 1 attempt, no further attempts before deadline).
		// The 10m default would mean ~6000 attempts — any non-default ceiling
		// pulled from the input must actually shorten the loop.
		const sidecars = fakeSidecars({ stdout: "", stderr: "compile error\n" });
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks);
		const { fetch, calls } = fakeFetch([
			new Response("502", { status: 502 }),
			new Response("502", { status: 502 }),
		]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			tcpConnect: alwaysConnected,
			sleep: async (ms) => {
				ticks += ms * 10; // advance fast so the loop exits in O(1) probes
			},
			now,
			readinessTimeoutMs: 50,
			readinessPollMs: 100,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("readiness_timeout");
		expect(calls.length).toBeLessThan(5);
	});

	// warren-33eb / warren-9b15 / warren-44ed: each phase-1 probe must be
	// bounded by the per-call timeout so a hung sidecar can't block the
	// wall clock. Under warren-44ed phase-1 uses `tcpConnect` (not fetch);
	// a tcpConnect that never resolves on its own still surfaces as
	// `connect_timeout` via the per-call timeout inside `tcpConnectOnce`.
	test("aborts hung phase-1 probes via per-call timeout and still hits the wall-clock deadline", async () => {
		const sidecars = fakeSidecars({ stdout: "", stderr: "compiling…\n" });
		const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
		let ticks = 0;
		const now = (): Date => new Date(t0 + ticks);

		// tcpConnect that respects the per-call `timeoutMs` argument by
		// resolving "not_connected" exactly at that bound — simulating a
		// TCP SYN that never gets ACKed. Without per-call bounding this
		// would hang forever and the deadline check would never run.
		let probeCalls = 0;
		const hangingTcp = (async (
			_host: string,
			_port: number,
			timeoutMs: number,
		): Promise<"connected" | "not_connected"> => {
			probeCalls++;
			return new Promise((resolve) => {
				setTimeout(() => resolve("not_connected"), timeoutMs);
			});
		}) as (host: string, port: number, timeoutMs: number) => Promise<"connected" | "not_connected">;

		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
			tcpConnect: hangingTcp,
			sleep: async () => {
				// Advance the wall clock past the deadline once a probe has aborted.
				ticks += 1_000;
			},
			now,
			connectTimeoutMs: 200,
			readinessTimeoutMs: 5_000,
			readinessPollMs: 50,
			probePerCallTimeoutMs: 10,
		});

		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("connect_timeout");
		// Loop must have iterated at least once and bounded — not a single hang.
		expect(probeCalls).toBeGreaterThanOrEqual(1);
		expect(probeCalls).toBeLessThan(20);
		const row = await repos.runs.require(runId);
		expect(row.previewState).toBe("failed");
		expect(row.previewPort).toBeNull();
		expect(row.previewFailureMessage).toContain("phase=connect");
	});

	test("PROBE_PER_CALL_TIMEOUT_MS is 2 seconds (warren-33eb)", () => {
		expect(PROBE_PER_CALL_TIMEOUT_MS).toBe(2_000);
	});

	// warren-9b15: DEFAULT_CONNECT_TIMEOUT_MS sizes the phase-1 "did anything
	// bind on the port?" budget. 5m covers shell pre-exec, dev-server CLI
	// startup, dependency import-graph load, and bind — i.e. sidecar startup
	// overhead. The bundler first-compile budget lives under readiness_timeout.
	test("DEFAULT_CONNECT_TIMEOUT_MS is 5 minutes (warren-9b15)", () => {
		expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(300_000);
	});

	test("falls back to stdout tail when stderr is empty", async () => {
		const sidecars = fakeSidecars({ stdout: "noisy stdout output\n", stderr: "" });
		let ticks = 0;
		const now = (): Date => new Date(new Date("2026-05-14T18:00:00.000Z").getTime() + ticks * 1000);
		const { fetch } = fakeFetch([new Response("nope", { status: 500 })]);
		const result = await launchPreview({
			runId,
			burrowId,
			previewConfig: PREVIEW_CONFIG,
			repos,
			allocator,
			sidecars: sidecars.client,
			fetch,
			sleep: async () => {
				ticks += 10;
			},
			now,
			readinessTimeoutMs: 5_000,
			readinessPollMs: 100,
		});
		expect((result as { failureTail: string }).failureTail).toContain("stdout output");
	});
});
