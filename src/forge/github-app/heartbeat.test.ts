import { describe, expect, test } from "bun:test";
import type { ForgeResult } from "../contract.ts";
import {
	DEFAULT_FORGE_HEARTBEAT_INTERVAL_MS,
	FORGE_HEARTBEAT_DISABLED_ENV,
	FORGE_HEARTBEAT_INTERVAL_ENV,
	FORGE_HEARTBEAT_METRIC,
	type ForgeHeartbeatLogger,
	type ForgeHeartbeatTimerHandle,
	loadForgeHeartbeatConfigFromEnv,
	MIN_FORGE_HEARTBEAT_INTERVAL_MS,
	startGitHubAppHeartbeat,
} from "./heartbeat.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: object;
	readonly msg?: string;
}

function makeLogger(): { logger: ForgeHeartbeatLogger; lines: LogLine[] } {
	const lines: LogLine[] = [];
	const push = (level: LogLine["level"]) => (obj: object, msg?: string) => {
		lines.push(msg === undefined ? { level, obj } : { level, obj, msg });
	};
	return { logger: { info: push("info"), warn: push("warn"), error: push("error") }, lines };
}

interface TickHarness {
	/** Fire the interval callback once, then flush the async tick. */
	fire(): Promise<void>;
	/** Flush the immediate boot tick (or any in-flight tick). */
	flush(): Promise<void>;
	readonly cleared: () => boolean;
}

/** Manual interval pair: captures the callback, records clearInterval. */
function makeTimer(): {
	setInterval: (cb: () => void, ms: number) => ForgeHeartbeatTimerHandle;
	clearInterval: (handle: ForgeHeartbeatTimerHandle) => void;
	harness: TickHarness;
} {
	let cb: (() => void) | null = null;
	let cleared = false;
	const flush = async () => {
		// Let the async tick's promise chain settle.
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	return {
		setInterval: (callback) => {
			cb = callback;
			return { fake: true };
		},
		clearInterval: () => {
			cleared = true;
		},
		harness: {
			async fire() {
				cb?.();
				await flush();
			},
			flush,
			cleared: () => cleared,
		},
	};
}

function okProbe(expiresAt = 123): () => Promise<ForgeResult<{ expiresAt: number | null }>> {
	return async () => ({ ok: true, value: { expiresAt } });
}

describe("loadForgeHeartbeatConfigFromEnv", () => {
	test("defaults to enabled at the five-minute cadence", () => {
		expect(loadForgeHeartbeatConfigFromEnv({})).toEqual({
			enabled: true,
			intervalMs: DEFAULT_FORGE_HEARTBEAT_INTERVAL_MS,
		});
	});

	test("parses a custom interval", () => {
		expect(
			loadForgeHeartbeatConfigFromEnv({ [FORGE_HEARTBEAT_INTERVAL_ENV]: "120000" }).intervalMs,
		).toBe(120000);
	});

	test("clamps a sub-floor interval up to the 30s floor instead of hammering the API", () => {
		expect(
			loadForgeHeartbeatConfigFromEnv({ [FORGE_HEARTBEAT_INTERVAL_ENV]: "1000" }).intervalMs,
		).toBe(MIN_FORGE_HEARTBEAT_INTERVAL_MS);
	});

	test("throws fail-loud on a non-integer interval", () => {
		expect(() =>
			loadForgeHeartbeatConfigFromEnv({ [FORGE_HEARTBEAT_INTERVAL_ENV]: "fast" }),
		).toThrow(FORGE_HEARTBEAT_INTERVAL_ENV);
	});

	test("honors the disabled flag in every accepted spelling", () => {
		for (const raw of ["1", "true", "YES", " on "]) {
			expect(loadForgeHeartbeatConfigFromEnv({ [FORGE_HEARTBEAT_DISABLED_ENV]: raw }).enabled).toBe(
				false,
			);
		}
		expect(loadForgeHeartbeatConfigFromEnv({ [FORGE_HEARTBEAT_DISABLED_ENV]: "0" }).enabled).toBe(
			true,
		);
	});
});

describe("startGitHubAppHeartbeat", () => {
	test("probes immediately at boot — a credential that died while warren was down is known within seconds", async () => {
		let calls = 0;
		const { logger, lines } = makeLogger();
		const timer = makeTimer();
		startGitHubAppHeartbeat({
			probe: async () => {
				calls += 1;
				return { ok: true, value: { expiresAt: 1 } };
			},
			intervalMs: 60000,
			logger,
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		expect(calls).toBe(1);
		expect(lines.filter((l) => l.level === "error")).toHaveLength(0);
	});

	test("a failed mint surfaces LOUDLY: error log with kind + detail, metrics counter with outcome/kind labels", async () => {
		const { logger, lines } = makeLogger();
		const timer = makeTimer();
		const increments: Array<{ name: string; labels: Record<string, string> }> = [];
		startGitHubAppHeartbeat({
			probe: async () => ({
				ok: false,
				error: { kind: "unauthorized", detail: "POST access_tokens → 401 Bad credentials" },
			}),
			intervalMs: 60000,
			logger,
			metrics: {
				increment: (name, labels) => {
					increments.push({ name, labels: { ...labels } });
				},
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		const errors = lines.filter((l) => l.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.msg).toContain("GitHub App credential probe FAILED");
		expect(errors[0]?.obj).toEqual({
			kind: "unauthorized",
			detail: "POST access_tokens → 401 Bad credentials",
		});
		expect(increments).toEqual([
			{ name: FORGE_HEARTBEAT_METRIC, labels: { outcome: "error", kind: "unauthorized" } },
		]);
	});

	test("logs an info-level recovery line on the first success after a failure", async () => {
		const { logger, lines } = makeLogger();
		const timer = makeTimer();
		let alive = false;
		startGitHubAppHeartbeat({
			probe: async () =>
				alive
					? { ok: true, value: { expiresAt: 42 } }
					: { ok: false, error: { kind: "unauthorized", detail: "401" } },
			intervalMs: 60000,
			logger,
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		alive = true;
		await timer.harness.fire();
		const recovery = lines.find((l) => l.level === "info");
		expect(recovery?.msg).toContain("recovered");
		expect(recovery?.obj).toEqual({ expiresAt: 42 });
		// A steady-state success after the recovery logs nothing further.
		await timer.harness.fire();
		expect(lines.filter((l) => l.level === "info")).toHaveLength(1);
	});

	test("increments the ok counter on a successful tick", async () => {
		const { logger } = makeLogger();
		const timer = makeTimer();
		const increments: string[] = [];
		startGitHubAppHeartbeat({
			probe: okProbe(),
			intervalMs: 60000,
			logger,
			metrics: {
				increment: (name, labels) => {
					increments.push(`${name}:${labels.outcome}`);
				},
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		expect(increments).toEqual([`${FORGE_HEARTBEAT_METRIC}:ok`]);
	});

	test("a throwing probe is a dead-credential signal, never a crashed loop", async () => {
		const { logger, lines } = makeLogger();
		const timer = makeTimer();
		let calls = 0;
		startGitHubAppHeartbeat({
			probe: async () => {
				calls += 1;
				throw new Error("boom");
			},
			intervalMs: 60000,
			logger,
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		await timer.harness.fire();
		expect(calls).toBe(2);
		const errors = lines.filter((l) => l.level === "error");
		expect(errors).toHaveLength(2);
		expect(errors[0]?.msg).toContain("probe threw");
		expect(errors[0]?.obj).toEqual({ reason: "boom" });
	});

	test("ticks never overlap — a slow probe skips the next tick instead of stacking", async () => {
		const { logger } = makeLogger();
		const timer = makeTimer();
		let calls = 0;
		const pending: Array<() => void> = [];
		startGitHubAppHeartbeat({
			probe: async () => {
				calls += 1;
				await new Promise<void>((resolve) => {
					pending.push(resolve);
				});
				return { ok: true, value: { expiresAt: 1 } };
			},
			intervalMs: 60000,
			logger,
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		expect(calls).toBe(1); // boot tick, still parked on `release`
		await timer.harness.fire(); // must be skipped: the boot tick is in flight
		expect(calls).toBe(1);
		pending[0]?.();
		await timer.harness.flush();
		await timer.harness.fire(); // in-flight probe finished — ticks flow again
		expect(calls).toBe(2);
	});

	test("stop() clears the interval and blocks further ticks", async () => {
		const { logger } = makeLogger();
		const timer = makeTimer();
		let calls = 0;
		const handle = startGitHubAppHeartbeat({
			probe: async () => {
				calls += 1;
				return { ok: true, value: { expiresAt: 1 } };
			},
			intervalMs: 60000,
			logger,
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await timer.harness.flush();
		handle.stop();
		expect(timer.harness.cleared()).toBe(true);
		await timer.harness.fire();
		expect(calls).toBe(1);
	});
});
