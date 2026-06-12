import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/client.ts";
import { BurrowClientPool } from "../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	DEFAULT_WORKER_PROBE_INTERVAL_MS,
	loadWorkerProbeConfigFromEnv,
	runProbeTick,
	startWorkerProbe,
} from "./probe.ts";

function stub(impl: (input: URL | RequestInfo) => Promise<Response>): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function okClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/ok.sock" } },
		fetch: stub(async () => jsonResponse(200, { ok: true })),
	});
}

function failingClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "tcp", hostname: "down", port: 1 } },
		fetch: stub(async () => {
			const err = new TypeError("fetch failed");
			(err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw err;
		}),
	});
}

describe("loadWorkerProbeConfigFromEnv", () => {
	test("returns defaults when no env vars are set", () => {
		expect(loadWorkerProbeConfigFromEnv({})).toEqual({ disabled: false });
	});

	test("parses positive integers", () => {
		expect(
			loadWorkerProbeConfigFromEnv({
				WARREN_WORKER_PROBE_INTERVAL_MS: "5000",
				WARREN_WORKER_PROBE_TIMEOUT_MS: "1500",
			}),
		).toEqual({ intervalMs: 5000, timeoutMs: 1500, disabled: false });
	});

	test("accepts 1/true/yes/on (case- and whitespace-insensitive) to flip the disabled flag", () => {
		for (const raw of ["1", "true", "On", "YES", " true "]) {
			expect(loadWorkerProbeConfigFromEnv({ WARREN_WORKER_PROBE_DISABLED: raw })).toEqual({
				disabled: true,
			});
		}
	});

	test("keeps disabled=false for empty / 0 / off", () => {
		for (const raw of ["", "0", "off"]) {
			expect(loadWorkerProbeConfigFromEnv({ WARREN_WORKER_PROBE_DISABLED: raw })).toEqual({
				disabled: false,
			});
		}
	});

	test("rejects non-integer intervals", () => {
		expect(() =>
			loadWorkerProbeConfigFromEnv({ WARREN_WORKER_PROBE_INTERVAL_MS: "nope" }),
		).toThrow();
	});

	test("rejects zero or negative intervals", () => {
		expect(() => loadWorkerProbeConfigFromEnv({ WARREN_WORKER_PROBE_INTERVAL_MS: "0" })).toThrow();
		expect(() =>
			loadWorkerProbeConfigFromEnv({ WARREN_WORKER_PROBE_INTERVAL_MS: "-10" }),
		).toThrow();
	});
});

describe("runProbeTick", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	test("flips a healthy worker to unreachable when probe fails", async () => {
		await repos.workers.upsert({ name: "alpha", url: "tcp://down:1" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", failingClient());

		const result = await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect((await repos.workers.require("alpha")).state).toBe("unreachable");
		expect(result.transitions).toEqual([
			{ workerName: "alpha", from: "healthy", to: "unreachable", reason: "probe_failed" },
		]);
	});

	test("flips an unreachable worker back to healthy on a successful probe", async () => {
		await repos.workers.upsert({
			name: "alpha",
			url: "unix:///tmp/ok.sock",
			state: "unreachable",
		});
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		const result = await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect((await repos.workers.require("alpha")).state).toBe("healthy");
		expect(result.transitions).toEqual([
			{ workerName: "alpha", from: "unreachable", to: "healthy", reason: "probe_ok" },
		]);
	});

	test("leaves a draining worker alone even when probe succeeds", async () => {
		await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/ok.sock", state: "draining" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		const result = await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect((await repos.workers.require("alpha")).state).toBe("draining");
		expect(result.transitions).toEqual([]);
	});

	test("leaves a draining worker alone even when probe fails", async () => {
		await repos.workers.upsert({ name: "alpha", url: "tcp://down:1", state: "draining" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", failingClient());

		await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect((await repos.workers.require("alpha")).state).toBe("draining");
	});

	test("no transition when probe result matches current state", async () => {
		await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/ok.sock", state: "healthy" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		const result = await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect(result.transitions).toEqual([]);
	});

	test("skips pool entries with no `workers` row", async () => {
		// Pool has alpha but no row in `workers` (drift scenario).
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		const warnings: object[] = [];
		const result = await runProbeTick({
			pool,
			workers: repos.workers,
			timeoutMs: 100,
			logger: { warn: (obj) => void warnings.push(obj) },
		});
		expect(result.transitions).toEqual([]);
		expect(warnings).toEqual([{ workerName: "alpha" }]);
	});

	test("reconciles multiple workers in one tick", async () => {
		await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/ok.sock" });
		await repos.workers.upsert({ name: "beta", url: "tcp://down:1" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());
		pool.register("beta", failingClient());

		await runProbeTick({ pool, workers: repos.workers, timeoutMs: 100 });
		expect((await repos.workers.require("alpha")).state).toBe("healthy");
		expect((await repos.workers.require("beta")).state).toBe("unreachable");
	});
});

describe("startWorkerProbe", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	test("runOnce drives one probe + reconciliation pass", async () => {
		await repos.workers.upsert({ name: "alpha", url: "tcp://down:1" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", failingClient());

		let intervalScheduled = false;
		const handle = startWorkerProbe({
			pool,
			workers: repos.workers,
			setInterval: () => {
				intervalScheduled = true;
				return {};
			},
			clearInterval: () => {},
		});
		expect(intervalScheduled).toBe(true);

		const result = await handle.runOnce();
		expect(handle.tickCount()).toBe(1);
		expect(result?.transitions).toEqual([
			{ workerName: "alpha", from: "healthy", to: "unreachable", reason: "probe_failed" },
		]);
		await handle.stop();
	});

	test("disabled loop never schedules an interval but still permits runOnce", async () => {
		await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/ok.sock" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		let intervalScheduled = false;
		const handle = startWorkerProbe({
			pool,
			workers: repos.workers,
			config: { disabled: true },
			setInterval: () => {
				intervalScheduled = true;
				return {};
			},
			clearInterval: () => {},
		});
		expect(intervalScheduled).toBe(false);

		const result = await handle.runOnce();
		expect(result).not.toBeNull();
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("runOnce returns null when fired after stop()", async () => {
		const pool = new BurrowClientPool({ repos });
		const handle = startWorkerProbe({
			pool,
			workers: repos.workers,
			setInterval: () => ({}),
			clearInterval: () => {},
		});
		await handle.stop();
		await expect(handle.runOnce()).resolves.toBeNull();
	});

	test("concurrent runOnce calls are coalesced (single-flight)", async () => {
		await repos.workers.upsert({ name: "alpha", url: "unix:///tmp/ok.sock" });
		const pool = new BurrowClientPool({ repos });
		pool.register("alpha", okClient());

		const handle = startWorkerProbe({
			pool,
			workers: repos.workers,
			setInterval: () => ({}),
			clearInterval: () => {},
		});
		const [first, second] = await Promise.all([handle.runOnce(), handle.runOnce()]);
		// One ran the probe, the other was skipped (returned null).
		const ranOnce = (first === null ? 0 : 1) + (second === null ? 0 : 1);
		expect(ranOnce).toBe(1);
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("DEFAULT_WORKER_PROBE_INTERVAL_MS is 30 seconds", () => {
		expect(DEFAULT_WORKER_PROBE_INTERVAL_MS).toBe(30_000);
	});
});
