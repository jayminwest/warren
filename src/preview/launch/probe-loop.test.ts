import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewPortAllocator } from "../port-allocator.ts";
import { launchPreview } from "./orchestrate.ts";
import {
	alwaysConnected,
	alwaysRefused,
	fakeFetch,
	fakeSidecars,
	fakeTcp,
	type LaunchTestEnv,
	PREVIEW_CONFIG,
	setupLaunchEnv,
} from "./test-helpers.ts";

// warren-9b15: phase 1 ("did anything bind?") uses connect_timeout, phase
// 2 ("did the bound server return 2xx?") uses readiness_timeout starting
// at the phase transition. A port that never binds surfaces as
// connect_timeout — distinct from readiness_timeout, so operators can tell
// "sidecar didn't even open the socket" from "server bound but bundler is
// slow" without staring at logs.
describe("two-phase probe loop (warren-9b15)", () => {
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
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
