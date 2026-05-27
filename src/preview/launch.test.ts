import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ServerPreviewConfig } from "../warren-config/index.ts";
import {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	formatPreviewUrl,
	launchPreview,
	loadPreviewLaunchConfigFromEnv,
	PROBE_PER_CALL_TIMEOUT_MS,
	type PreviewSidecarsClient,
	tcpConnectOnce,
} from "./launch.ts";
import { PreviewPortAllocator } from "./port-allocator.ts";

const PREVIEW_CONFIG: ServerPreviewConfig = {
	type: "server",
	command: "bun run dev",
	port: 3000,
};

interface FakeSidecar {
	client: PreviewSidecarsClient;
	readonly creates: Array<{
		burrowId: string;
		command: readonly string[];
		env?: Record<string, string>;
		inboundPortForward?: { hostPort: number; sandboxPort: number };
		readinessPath?: string;
	}>;
	readonly deletes: Array<{ burrowId: string; sidecarId: string }>;
	logs: { stdout: string; stderr: string };
	createImpl?: () => Promise<{ id: string; state: string }>;
	/**
	 * Per-sidecar-id status queue (warren-d9e7). Each successive `get()` call
	 * pops the next status; once exhausted, the last value is returned forever.
	 * Defaults to `{state: 'exited', exitCode: 0}` when no entries are seeded,
	 * which keeps the dev-server-sidecar path (no status polling) unchanged.
	 */
	readonly statusQueue: Map<string, Array<{ state: string; exitCode: number | null }>>;
}

type CreateInput = Parameters<PreviewSidecarsClient["create"]>[0];

function fakeSidecars(
	initialLogs: { stdout: string; stderr: string } = { stdout: "", stderr: "" },
): FakeSidecar {
	const creates: FakeSidecar["creates"] = [];
	const deletes: FakeSidecar["deletes"] = [];
	const statusQueue = new Map<string, Array<{ state: string; exitCode: number | null }>>();
	const state: FakeSidecar = {
		client: {} as PreviewSidecarsClient,
		creates,
		deletes,
		logs: { ...initialLogs },
		statusQueue,
	};
	let nextSidecarSeq = 0;
	const client: PreviewSidecarsClient = {
		async create(input: CreateInput) {
			creates.push({
				burrowId: input.burrowId,
				command: [...input.command],
				...(input.env !== undefined ? { env: { ...input.env } } : {}),
				...(input.inboundPortForward !== undefined
					? { inboundPortForward: input.inboundPortForward }
					: {}),
				...(input.readinessPath !== undefined ? { readinessPath: input.readinessPath } : {}),
			});
			if (state.createImpl !== undefined) return state.createImpl();
			nextSidecarSeq++;
			return { id: `sc_test_${nextSidecarSeq}`, state: "live" };
		},
		async logs() {
			return { stdout: state.logs.stdout, stderr: state.logs.stderr };
		},
		async delete(burrowId: string, sidecarId: string) {
			deletes.push({ burrowId, sidecarId });
		},
		async get(_burrowId: string, sidecarId: string) {
			const queue = statusQueue.get(sidecarId);
			if (queue === undefined || queue.length === 0) {
				return { state: "exited", exitCode: 0 };
			}
			return queue.length === 1
				? (queue[0] as { state: string; exitCode: number | null })
				: (queue.shift() as { state: string; exitCode: number | null });
		},
	};
	state.client = client;
	return state;
}

function fakeFetch(responses: Array<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		const next = responses[i++];
		if (next === undefined) throw new Error("fakeFetch: out of responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

// warren-44ed / pl-592f step 2: phase-1 now uses tcpConnectOnce (raw TCP)
// instead of fetch. Tests that want to exercise phase-2 readiness logic
// inject `tcpConnect: alwaysConnected` so phase-1 transitions on the first
// poll; tests that exercise phase-1 itself supply explicit sequences via
// `fakeTcp`.
const alwaysConnected: (
	host: string,
	port: number,
	timeoutMs: number,
) => Promise<"connected" | "not_connected"> = async () => "connected";

const alwaysRefused: (
	host: string,
	port: number,
	timeoutMs: number,
) => Promise<"connected" | "not_connected"> = async () => "not_connected";

function fakeTcp(outcomes: Array<"connected" | "not_connected">): {
	tcpConnect: (
		host: string,
		port: number,
		timeoutMs: number,
	) => Promise<"connected" | "not_connected">;
	calls: number;
} {
	const state = { calls: 0 };
	const tcpConnect = async (): Promise<"connected" | "not_connected"> => {
		const next = outcomes[state.calls++];
		if (next === undefined) {
			throw new Error("fakeTcp: out of outcomes");
		}
		return next;
	};
	return {
		tcpConnect,
		get calls() {
			return state.calls;
		},
	};
}

describe("launchPreview", () => {
	let db: WarrenDb;
	let repos: Repos;
	let allocator: PreviewPortAllocator;
	let runId: string;
	let burrowId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaa",
		});
		runId = run.id;
		burrowId = "bur_aaaa";
		allocator = new PreviewPortAllocator(DrizzleAdapter.for(db), { start: 40000, end: 40002 });
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

	// warren-9b15: phase 1 ("did anything bind?") uses connect_timeout, phase
	// 2 ("did the bound server return 2xx?") uses readiness_timeout starting
	// at the phase transition. A port that never binds surfaces as
	// connect_timeout — distinct from readiness_timeout, so operators can tell
	// "sidecar didn't even open the socket" from "server bound but bundler is
	// slow" without staring at logs.
	describe("two-phase probe loop (warren-9b15)", () => {
		test("returns connect_timeout when the port never accepts a connection", async () => {
			const sidecars = fakeSidecars({ stdout: "", stderr: "spawn refused\n" });
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);
			// warren-44ed: phase-1 uses tcpConnect; an always-refused tcpConnect
			// means phase 1 never transitions, connect_timeout fires.
			const refusingFetch = (async () => {
				throw new TypeError("fetch failed: ECONNREFUSED");
			}) as unknown as typeof fetch;
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: PREVIEW_CONFIG,
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: refusingFetch,
				tcpConnect: alwaysRefused,
				sleep: async () => {
					ticks += 1_000;
				},
				now,
				connectTimeoutMs: 200,
				readinessTimeoutMs: 5_000,
				readinessPollMs: 50,
			});
			expect(result.ok).toBe(false);
			expect((result as { reason: string }).reason).toBe("connect_timeout");
			expect((result as { failureTail: string }).failureTail).toContain("spawn refused");
			expect(sidecars.deletes).toHaveLength(1);
			const row = await repos.runs.require(runId);
			expect(row.previewState).toBe("failed");
			expect(row.previewPort).toBeNull();
			expect(row.previewFailureMessage).toContain("phase=connect");
			expect(row.previewFailureMessage).toContain("did not accept");
		});

		test("transitions phase 1 → phase 2 on first successful TCP connect, then waits the full readiness budget", async () => {
			const sidecars = fakeSidecars({ stdout: "", stderr: "compiling…\n" });
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);
			// warren-44ed: phase-1 is now TCP-only.
			// First tcpConnect: not_connected (phase 1, no transition).
			// Second tcpConnect: connected (phase 1 → phase 2 transition).
			// Phase 2 fetch: 502 then 200 (→ ready).
			const tcp = fakeTcp(["not_connected", "connected"]);
			let i = 0;
			const fetchImpl = (async (input: URL | RequestInfo): Promise<Response> => {
				i++;
				if (i === 1) return new Response("bad gateway", { status: 502 });
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				expect(url).toBe("http://127.0.0.1:40000/");
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch;
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: PREVIEW_CONFIG,
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: fetchImpl,
				tcpConnect: tcp.tcpConnect,
				sleep: async () => {
					ticks += 10;
				},
				now,
				connectTimeoutMs: 5_000,
				readinessTimeoutMs: 5_000,
				readinessPollMs: 10,
			});
			expect(result.ok).toBe(true);
			expect(tcp.calls).toBe(2);
			expect(i).toBe(2);
			const row = await repos.runs.require(runId);
			expect(row.previewState).toBe("live");
			expect(row.previewFailureMessage).toBeNull();
		});

		test("connect_timeout deadline does not count against readiness_timeout (slow bind → fast compile passes)", async () => {
			const sidecars = fakeSidecars();
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);
			// Phase 1: 3 not_connected probes eat ~3000ms of wall clock
			// (longer than readinessTimeoutMs alone would allow). Phase 2: first
			// probe is 200. With a single-phase deadline starting at create, the
			// 200ms readiness budget would have been exhausted by phase-1 waits;
			// the two-phase contract keeps it intact.
			const tcp = fakeTcp(["not_connected", "not_connected", "not_connected", "connected"]);
			let i = 0;
			const fetchImpl = (async (): Promise<Response> => {
				i++;
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch;
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: PREVIEW_CONFIG,
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: fetchImpl,
				tcpConnect: tcp.tcpConnect,
				sleep: async () => {
					ticks += 1_000;
				},
				now,
				connectTimeoutMs: 10_000,
				readinessTimeoutMs: 200,
				readinessPollMs: 50,
			});
			expect(result.ok).toBe(true);
			expect(tcp.calls).toBe(4);
			expect(i).toBe(1);
		});

		test("readiness_timeout failure message records phase=readiness", async () => {
			const sidecars = fakeSidecars({ stdout: "", stderr: "compile error\n" });
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);
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
					ticks += 5_000;
				},
				now,
				connectTimeoutMs: 5_000,
				readinessTimeoutMs: 2_000,
				readinessPollMs: 100,
			});
			expect(result.ok).toBe(false);
			expect((result as { reason: string }).reason).toBe("readiness_timeout");
			const row = await repos.runs.require(runId);
			expect(row.previewFailureMessage).toContain("phase=readiness");
		});

		// warren-f04c / pl-592f step 3: regression for warren-c3a2 — a dev server
		// (e.g. Next.js mid-compile) that binds the port quickly but takes longer
		// than probePerCallTimeoutMs to send its first response headers used to
		// be misclassified as `not_connected` by the old HTTP-based phase-1 probe,
		// burning the connect budget and failing with connect_timeout. Under
		// warren-44ed phase-1 is TCP-only (tcpConnectOnce), so the bound port is
		// observed within one poll interval and phase-2 (which speaks HTTP and
		// has the larger readiness budget) eventually sees 2xx.
		test("slow-first-headers but bound port reaches phase-2 readiness and succeeds (warren-c3a2 regression)", async () => {
			const sidecars = fakeSidecars();
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);

			// Phase-1 TCP: connected on the first probe (port is bound).
			const tcp = fakeTcp(["connected"]);

			// Phase-2 fetch: first N calls simulate "sent SYN-ACK but stalled
			// mid-headers, AbortController fired" — i.e. exactly the failure mode
			// that used to ruin phase-1 under the HTTP probe. Then a 200 lands.
			let fetchCalls = 0;
			const hangingHeaders = (async (): Promise<Response> => {
				fetchCalls++;
				if (fetchCalls < 3) {
					// AbortController's signal aborts surface as a thrown TypeError /
					// DOMException from fetch — same arm probeOnce's catch handles.
					throw new DOMException("aborted", "AbortError");
				}
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch;

			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: PREVIEW_CONFIG,
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: hangingHeaders,
				tcpConnect: tcp.tcpConnect,
				sleep: async () => {
					ticks += 50;
				},
				now,
				connectTimeoutMs: 2_000,
				readinessTimeoutMs: 10_000,
				readinessPollMs: 50,
				probePerCallTimeoutMs: 25,
			});

			expect(result.ok).toBe(true);
			// Phase-1 succeeded immediately — only one TCP probe.
			expect(tcp.calls).toBe(1);
			// Phase-2 saw the slow-headers aborts AND the eventual 200.
			expect(fetchCalls).toBe(3);
			const row = await repos.runs.require(runId);
			expect(row.previewState).toBe("live");
			expect(row.previewFailureMessage).toBeNull();
		});
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

	// warren-d9e7: setup pre-step splits dependency install from dev-server bind
	// so each phase has its own timeout and failure reason. The dev-server
	// sidecar must not spawn until setup exits 0; setup non-zero exits surface
	// as `setup_failed`; setup hangs past `setup_timeout` surface as
	// `setup_timeout`. Projects without a `setup:` field see no behavior change.
	describe("setup pre-step (warren-d9e7)", () => {
		test("runs setup to completion before spawning the dev server, then probes readiness", async () => {
			const sidecars = fakeSidecars();
			sidecars.statusQueue.set("sc_test_1", [
				{ state: "running", exitCode: null },
				{ state: "exited", exitCode: 0 },
			]);
			const { fetch } = fakeFetch([new Response("ok", { status: 200 })]);
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: { ...PREVIEW_CONFIG, setup: "pnpm install" },
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch,
				tcpConnect: alwaysConnected,
				sleep: async () => {},
				now: () => new Date("2026-05-14T18:00:00.000Z"),
			});
			expect(result.ok).toBe(true);
			expect((result as { sidecarId: string }).sidecarId).toBe("sc_test_2");
			// First create = setup (no inboundPortForward), second = dev server.
			expect(sidecars.creates).toHaveLength(2);
			expect(sidecars.creates[0]?.command).toEqual(["sh", "-c", "pnpm install"]);
			expect(sidecars.creates[0]?.inboundPortForward).toBeUndefined();
			expect(sidecars.creates[0]?.env).toBeUndefined();
			expect(sidecars.creates[1]?.command).toEqual(["sh", "-c", "bun run dev"]);
			expect(sidecars.creates[1]?.inboundPortForward).toEqual({
				hostPort: 40000,
				sandboxPort: 3000,
			});
			// Setup sidecar is cleaned up on success.
			expect(sidecars.deletes).toContainEqual({ burrowId, sidecarId: "sc_test_1" });
		});

		test("non-zero setup exit returns setup_failed, never spawns the dev server", async () => {
			const sidecars = fakeSidecars({ stdout: "", stderr: "ERR_PNPM_FETCH 404\n" });
			sidecars.statusQueue.set("sc_test_1", [{ state: "exited", exitCode: 1 }]);
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: { ...PREVIEW_CONFIG, setup: "pnpm install" },
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
				sleep: async () => {},
				now: () => new Date("2026-05-14T18:00:00.000Z"),
			});
			expect(result.ok).toBe(false);
			expect((result as { reason: string }).reason).toBe("setup_failed");
			expect((result as { failureTail: string }).failureTail).toContain("ERR_PNPM_FETCH");
			// Only the setup sidecar was created; the dev server never spawned.
			expect(sidecars.creates).toHaveLength(1);
			expect(sidecars.deletes).toEqual([{ burrowId, sidecarId: "sc_test_1" }]);
			const row = await repos.runs.require(runId);
			expect(row.previewState).toBe("failed");
			expect(row.previewPort).toBeNull();
			expect(row.previewFailureMessage).toContain("setup exited with code 1");
			expect(row.previewFailureMessage).toContain("ERR_PNPM_FETCH");
		});

		test("setup that never exits returns setup_timeout and deletes the lingering sidecar", async () => {
			const sidecars = fakeSidecars({ stdout: "installing…\n", stderr: "" });
			// Status never transitions to 'exited' — every poll returns 'running'.
			sidecars.statusQueue.set("sc_test_1", [{ state: "running", exitCode: null }]);
			const t0 = new Date("2026-05-14T18:00:00.000Z").getTime();
			let ticks = 0;
			const now = (): Date => new Date(t0 + ticks);
			const result = await launchPreview({
				runId,
				burrowId,
				previewConfig: { ...PREVIEW_CONFIG, setup: "sleep 9999" },
				repos,
				allocator,
				sidecars: sidecars.client,
				fetch: (async () => new Response("never", { status: 200 })) as unknown as typeof fetch,
				sleep: async (ms) => {
					ticks += ms * 100; // advance fast so the loop hits the deadline in O(1)
				},
				now,
				setupTimeoutMs: 200,
				setupPollMs: 50,
			});
			expect(result.ok).toBe(false);
			expect((result as { reason: string }).reason).toBe("setup_timeout");
			// Dev server sidecar was never spawned; setup was deleted.
			expect(sidecars.creates).toHaveLength(1);
			expect(sidecars.deletes).toEqual([{ burrowId, sidecarId: "sc_test_1" }]);
			const row = await repos.runs.require(runId);
			expect(row.previewState).toBe("failed");
			expect(row.previewPort).toBeNull();
			expect(row.previewFailureMessage).toContain("setup did not exit within 200ms");
		});

		test("no setup field leaves the existing single-sidecar path unchanged", async () => {
			const sidecars = fakeSidecars();
			const { fetch } = fakeFetch([new Response("ok", { status: 200 })]);
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
			expect(result.ok).toBe(true);
			// Only the dev-server sidecar is spawned; no setup sidecar.
			expect(sidecars.creates).toHaveLength(1);
			expect(sidecars.creates[0]?.inboundPortForward).toEqual({
				hostPort: 40000,
				sandboxPort: 3000,
			});
		});
	});
});

describe("loadPreviewLaunchConfigFromEnv", () => {
	test("returns host=null when WARREN_PREVIEW_HOST is unset", () => {
		expect(loadPreviewLaunchConfigFromEnv({})).toEqual({ host: null, mode: "path" });
	});

	test("returns host=null on whitespace-only value", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: "   " })).toEqual({
			host: null,
			mode: "path",
		});
	});

	test("returns the trimmed host suffix", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: " warren.example.com " })).toEqual(
			{ host: "warren.example.com", mode: "path" },
		);
	});

	test("defaults mode to 'path' when WARREN_PREVIEW_MODE is unset (warren-fcb7)", () => {
		expect(loadPreviewLaunchConfigFromEnv({}).mode).toBe("path");
	});

	test("accepts WARREN_PREVIEW_MODE=subdomain (case-insensitive, trimmed)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "subdomain" }).mode).toBe(
			"subdomain",
		);
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: " SUBDOMAIN " }).mode).toBe(
			"subdomain",
		);
	});

	test("accepts WARREN_PREVIEW_MODE=path (explicit opt-in matches default)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "path" }).mode).toBe("path");
	});

	test("invalid WARREN_PREVIEW_MODE silently falls back to 'path' default", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "wildcard" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "   " }).mode).toBe("path");
	});
});

describe("formatPreviewUrl", () => {
	test("subdomain mode renders https URL with run id sub-host (no trailing slash)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "subdomain")).toBe(
			"https://run-run_abc123.warren.example.com",
		);
	});

	test("path mode renders https URL under /p/<id>/ with trailing slash (warren-c3c4)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "path")).toBe(
			"https://warren.example.com/p/run_abc123/",
		);
	});
});

// warren-f04c / pl-592f step 3: direct unit tests for the phase-1 TCP-only
// probe helper. These exercise the real Bun.connect path (not an injected
// fake) on localhost, so a regression that breaks the helper itself \u2014
// e.g. failing to close the socket, never resolving on refused, ignoring
// the timeout \u2014 surfaces here instead of leaking into integration tests.
describe("tcpConnectOnce (warren-49d9 / pl-592f step 1)", () => {
	test("returns 'connected' for a port that is listening, and closes the socket", async () => {
		// Bind a real TCP listener on an ephemeral port. We track inbound
		// sockets so we can assert the probe closes its side promptly.
		const openedSockets: Array<{ closed: boolean }> = [];
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(_sock) {
					const rec = { closed: false };
					openedSockets.push(rec);
				},
				close(_sock) {
					const rec = openedSockets[openedSockets.length - 1];
					if (rec !== undefined) rec.closed = true;
				},
				data() {},
				error() {},
			},
		});
		try {
			const port = server.port;
			const outcome = await tcpConnectOnce("127.0.0.1", port, 1_000);
			expect(outcome).toBe("connected");
			// Give the kernel a tick to deliver the close.
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(openedSockets.length).toBeGreaterThanOrEqual(1);
			// At least one socket from the probe should be closed.
			expect(openedSockets.some((s) => s.closed)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("returns 'not_connected' when the port is refused (no listener)", async () => {
		// Bind then immediately stop so the port is almost certainly free
		// and refused. (Using a fixed high port risks collisions in CI.)
		const tmp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { open() {}, close() {}, data() {}, error() {} },
		});
		const port = tmp.port;
		tmp.stop(true);
		// Tiny wait so the kernel finishes tearing down the listener.
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		const outcome = await tcpConnectOnce("127.0.0.1", port, 1_000);
		expect(outcome).toBe("not_connected");
	});

	test("returns 'not_connected' when the connect handshake exceeds timeoutMs", async () => {
		// 192.0.2.1 is RFC 5737 TEST-NET-1 \u2014 reserved for documentation and
		// reliably unrouted on real networks, so SYNs are dropped and the
		// timer fires. If the local stack rejects it synchronously (e.g.
		// EHOSTUNREACH on locked-down sandboxes) we still get 'not_connected'
		// via the error arm \u2014 same outcome, same assertion.
		const start = Date.now();
		const outcome = await tcpConnectOnce("192.0.2.1", 1, 100);
		const elapsed = Date.now() - start;
		expect(outcome).toBe("not_connected");
		// Must respect the timeoutMs bound (with generous slack for CI).
		expect(elapsed).toBeLessThan(2_000);
	});
});
