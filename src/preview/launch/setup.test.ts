import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewPortAllocator } from "../port-allocator.ts";
import { launchPreview } from "./orchestrate.ts";
import {
	alwaysConnected,
	fakeFetch,
	fakeSidecars,
	type LaunchTestEnv,
	PREVIEW_CONFIG,
	setupLaunchEnv,
} from "./test-helpers.ts";

// warren-d9e7: setup pre-step splits dependency install from dev-server bind
// so each phase has its own timeout and failure reason. The dev-server
// sidecar must not spawn until setup exits 0; setup non-zero exits surface
// as `setup_failed`; setup hangs past `setup_timeout` surface as
// `setup_timeout`. Projects without a `setup:` field see no behavior change.
describe("setup pre-step (warren-d9e7)", () => {
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
