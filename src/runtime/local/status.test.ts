/**
 * `LocalProvider.status()` — burrow's `runs.get` wrapped as the seam's
 * out-of-band `RunStatus` reconcile snapshot (pl-829f step 9). Drives the real
 * body against the burrow-client fetch-stub fake so every phase mapping, the
 * OOM-marker recovery, the 404 → exists:false rule, and the event-cursor
 * derivation are exercised with no real socket.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	type BurrowFetchPlan,
	makeBurrowClient,
	makePool,
	setupRepos,
} from "../../runs/spawn/test-helpers.ts";
import type { RunHandle } from "../contract.ts";
import { LocalProvider } from "./provider.ts";

let openDb: WarrenDb | null = null;

afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function repos(): Promise<Repos> {
	const { db, repos } = await setupRepos();
	openDb = db;
	return repos;
}

const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

async function localProvider(
	plan: BurrowFetchPlan = {},
): Promise<{ provider: LocalProvider; calls: ReturnType<typeof makeBurrowClient>["calls"] }> {
	const r = await repos();
	const { client, calls } = makeBurrowClient(plan);
	const pool = await makePool(r, client);
	const provider = new LocalProvider({ burrowClient: () => pool });
	return { provider, calls };
}

describe("LocalProvider.status — phase + terminalReason mapping", () => {
	test("queued → phase queued, no terminalReason", async () => {
		const { provider } = await localProvider({ runGet: { state: "queued", exitCode: null } });
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("queued");
		expect(status.terminalReason).toBeUndefined();
		expect(status.exists).toBe(true);
	});

	test("running → phase running, no terminalReason", async () => {
		const { provider } = await localProvider({ runGet: { state: "running" } });
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("running");
		expect(status.terminalReason).toBeUndefined();
	});

	test("succeeded → terminalReason completed, exitCode carried", async () => {
		const { provider } = await localProvider({ runGet: { state: "succeeded", exitCode: 0 } });
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("succeeded");
		expect(status.terminalReason).toBe("completed");
		expect(status.exitCode).toBe(0);
	});

	test("cancelled → terminalReason cancelled", async () => {
		const { provider } = await localProvider({ runGet: { state: "cancelled", exitCode: 143 } });
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("cancelled");
		expect(status.terminalReason).toBe("cancelled");
	});

	test("failed without OOM marker → terminalReason error", async () => {
		const { provider } = await localProvider({
			runGet: { state: "failed", exitCode: 1, errorMessage: "event stream failed: boom" },
		});
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("failed");
		expect(status.terminalReason).toBe("error");
	});

	test("failed with burrow's OOM marker → terminalReason oom_killed", async () => {
		const { provider } = await localProvider({
			runGet: {
				state: "failed",
				exitCode: 137,
				// The exact string burrow's dispatch stamps on an OOM-killed run.
				errorMessage: "sandbox memory limit exceeded (oom-killed, exit 137)",
			},
		});
		const status = await provider.status(HANDLE);
		expect(status.phase).toBe("failed");
		expect(status.terminalReason).toBe("oom_killed");
		expect(status.exitCode).toBe(137);
	});
});

describe("LocalProvider.status — missing run (correction 7)", () => {
	test("burrow 404 → exists:false + terminalReason lost, never throws", async () => {
		const { provider, calls } = await localProvider({ runGetStatus: 404 });
		const status = await provider.status(HANDLE);
		expect(status.exists).toBe(false);
		expect(status.phase).toBe("failed");
		expect(status.terminalReason).toBe("lost");
		expect(status.lastEventSeq).toBe(0);
		expect(status.lastEventTs).toBeNull();
		// No event replay attempted once the run is known gone.
		expect(calls.some((c) => c.path.endsWith("/events"))).toBe(false);
	});
});

describe("LocalProvider.status — event cursor (lastEventSeq / lastEventTs)", () => {
	test("derives the max seq + its ts from the burrow event replay", async () => {
		const { provider, calls } = await localProvider({
			runGet: { state: "running" },
			replayEvents: [
				{ seq: 1, ts: "2026-05-08T12:00:01.000Z" },
				{ seq: 2, ts: "2026-05-08T12:00:02.000Z" },
				{ seq: 3, ts: "2026-05-08T12:00:03.000Z" },
			],
		});
		const status = await provider.status(HANDLE);
		expect(status.lastEventSeq).toBe(3);
		expect(status.lastEventTs).toBe("2026-05-08T12:00:03.000Z");
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /runs/run_zzzzzzzzzzzz",
			"GET /burrows/bur_aaaaaaaaaaaa/events",
		]);
	});

	test("ignores events from other runs and burrow-level (runId:null) events", async () => {
		const { provider } = await localProvider({
			runGet: { state: "running" },
			replayEvents: [
				{ seq: 1, ts: "2026-05-08T12:00:01.000Z" },
				{ seq: 2, ts: "2026-05-08T12:00:02.000Z", runId: "run_other0000" },
				{ seq: 3, ts: "2026-05-08T12:00:03.000Z", runId: null },
			],
		});
		const status = await provider.status(HANDLE);
		// Only seq 1 belongs to this run.
		expect(status.lastEventSeq).toBe(1);
		expect(status.lastEventTs).toBe("2026-05-08T12:00:01.000Z");
	});

	test("no events for the run → seq 0, ts null", async () => {
		const { provider } = await localProvider({ runGet: { state: "queued" }, replayEvents: [] });
		const status = await provider.status(HANDLE);
		expect(status.lastEventSeq).toBe(0);
		expect(status.lastEventTs).toBeNull();
	});
});
