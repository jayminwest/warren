import { describe, expect, test } from "bun:test";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { FORGE_HEARTBEAT_INTERVAL_ENV } from "../../forge/github-app/heartbeat.ts";
import { GitHubAppForge } from "../../forge/github-app/provider.ts";
import {
	generateTestAppKeyPair,
	stubGitHubAppServer,
} from "../../forge/github-app/test-helpers.ts";
import { HotForge } from "../../forge/hot-forge.ts";
import { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { Logger } from "../types.ts";
import { bootForgeHeartbeatFromEnv } from "./forge-heartbeat-wiring.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: object;
	readonly msg?: string;
}

function makeLogger(): { logger: Logger; lines: LogLine[] } {
	const lines: LogLine[] = [];
	const push = (level: LogLine["level"]) => (obj: object, msg?: string) => {
		lines.push(msg === undefined ? { level, obj } : { level, obj, msg });
	};
	const logger: Logger = { info: push("info"), warn: push("warn"), error: push("error") };
	return { logger, lines };
}

function makeAppForge(mints?: { count: number }): GitHubAppForge {
	const { privateKeyPem } = generateTestAppKeyPair();
	return new GitHubAppForge({
		appId: "4560297",
		installationId: "555",
		privateKey: privateKeyPem,
		fetch: stubGitHubAppServer(mints === undefined ? {} : { mints }).fetch,
	});
}

async function flushTicks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("bootForgeHeartbeatFromEnv (warren-1295)", () => {
	test("unwraps a HotForge wrapper and probes the App delegate (warren-b504)", () => {
		const { logger } = makeLogger();
		const handle = bootForgeHeartbeatFromEnv({
			env: { WARREN_FORGE: "app" },
			forge: new HotForge(makeAppForge()),
			logger,
			metricsRegistry: undefined,
		});
		expect(handle).not.toBeUndefined();
		handle?.stop();
	});

	test("returns undefined when the resolved forge is not the App provider (default github arm)", () => {
		const { logger } = makeLogger();
		const handle = bootForgeHeartbeatFromEnv({
			env: {},
			forge: new FakeForge(),
			logger,
			metricsRegistry: undefined,
		});
		expect(handle).toBeUndefined();
	});

	test("returns undefined (with a log line) when the operator opts out", () => {
		const { logger, lines } = makeLogger();
		const handle = bootForgeHeartbeatFromEnv({
			env: { WARREN_FORGE: "app", WARREN_FORGE_HEARTBEAT_DISABLED: "1" },
			forge: makeAppForge(),
			logger,
			metricsRegistry: undefined,
		});
		expect(handle).toBeUndefined();
		expect(lines.some((l) => l.msg?.includes("WARREN_FORGE_HEARTBEAT_DISABLED"))).toBe(true);
	});

	test("warns and boots nothing when WARREN_FORGE=app but the forge is not a GitHubAppForge", () => {
		const { logger, lines } = makeLogger();
		const handle = bootForgeHeartbeatFromEnv({
			env: { WARREN_FORGE: "app" },
			forge: new FakeForge(),
			logger,
			metricsRegistry: undefined,
		});
		expect(handle).toBeUndefined();
		expect(lines.some((l) => l.level === "warn")).toBe(true);
	});

	test("boots the probe under WARREN_FORGE=app: immediate mint, boot log line, metrics tick, clean stop", async () => {
		const mints = { count: 0 };
		const { logger, lines } = makeLogger();
		const metrics = new MetricsRegistry();
		const handle = bootForgeHeartbeatFromEnv({
			env: { WARREN_FORGE: "app", [FORGE_HEARTBEAT_INTERVAL_ENV]: "30000" },
			forge: makeAppForge(mints),
			logger,
			metricsRegistry: metrics,
		});
		if (handle === undefined) throw new Error("expected a heartbeat handle under WARREN_FORGE=app");
		await flushTicks();
		// The immediate boot tick force-minted against the stub App server.
		expect(mints.count).toBe(1);
		expect(
			lines.some((l) => l.level === "info" && l.msg?.includes("forge heartbeat running")),
		).toBe(true);
		expect(metrics.snapshot().some((c) => c.labels.outcome === "ok")).toBe(true);
		handle.stop();
	});

	test("a dead credential surfaces as an error log + failure counter on the boot tick", async () => {
		const { logger, lines } = makeLogger();
		const metrics = new MetricsRegistry();
		const { privateKeyPem } = generateTestAppKeyPair();
		const deadForge = new GitHubAppForge({
			appId: "4560297",
			installationId: "555",
			privateKey: privateKeyPem,
			fetch: (() =>
				Promise.resolve(
					new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
				)) as unknown as typeof fetch,
		});
		const handle = bootForgeHeartbeatFromEnv({
			env: { WARREN_FORGE: "app" },
			forge: deadForge,
			logger,
			metricsRegistry: metrics,
		});
		if (handle === undefined) throw new Error("expected a heartbeat handle");
		await flushTicks();
		const errors = lines.filter((l) => l.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.msg).toContain("credential probe FAILED");
		expect(metrics.snapshot().some((c) => c.labels.outcome === "error")).toBe(true);
		handle.stop();
	});
});
