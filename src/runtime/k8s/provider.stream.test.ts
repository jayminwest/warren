import { describe, expect, test } from "bun:test";
import type { CoreV1Api, V1Pod } from "@kubernetes/client-node";
import type { RunHandle } from "../contract.ts";
import type { LogFollowFn } from "./log-stream.ts";
import type { PodCacheReader } from "./pod-watcher.ts";
import { K8sProvider } from "./provider.ts";

/**
 * `K8sProvider.streamEvents` logger threading (warren-72a8). The provider must
 * pass `deps.logger` into `streamK8sLogs` so the pump's backoff/parse warnings
 * surface instead of being silent no-ops.
 */
describe("K8sProvider.streamEvents — logger threading (warren-72a8)", () => {
	/** A pod-cache returning a terminal (Succeeded) pod so the stream drains + ends. */
	const terminalPodCache: PodCacheReader = {
		getByRunId: (): V1Pod => ({ status: { phase: "Succeeded" } }) as V1Pod,
	};
	/** A follow seam that pushes one non-JSON line then closes cleanly. */
	const oneNonJsonLine =
		(line: string): LogFollowFn =>
		(_params, onData, onDone) => {
			onData(`${line}\n`);
			onDone(undefined);
			return Promise.resolve({ abort: () => {} });
		};
	const throwingCoreApi = (): CoreV1Api => {
		throw new Error("coreApi must not be called (podCache short-circuits status)");
	};

	test("threads deps.logger so the pump's parse-failure warning surfaces", async () => {
		// The non-JSON line is dropped and logged; a clean EOF + terminal probe ends the
		// stream. If the provider failed to thread the logger, warn would be a no-op.
		const warns: { obj: unknown; msg: string }[] = [];
		const provider = new K8sProvider({
			coreApi: throwingCoreApi,
			serverEnv: {},
			logFollow: oneNonJsonLine("this-is-not-json"),
			podCache: terminalPodCache,
			logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
		});
		const handle: RunHandle = { runId: "run_log", sandboxId: "run-run-log", providerRunId: "uid" };
		const events = [];
		for await (const ev of provider.streamEvents(handle)) events.push(ev);
		expect(warns.some((w) => w.msg.includes("non-JSON pod-log line"))).toBe(true);
	});

	test("without a logger the stream still drains cleanly (no throw)", async () => {
		const provider = new K8sProvider({
			coreApi: throwingCoreApi,
			serverEnv: {},
			logFollow: oneNonJsonLine("also-not-json"),
			podCache: terminalPodCache,
		});
		const handle: RunHandle = {
			runId: "run_log2",
			sandboxId: "run-run-log2",
			providerRunId: "uid",
		};
		const events = [];
		for await (const ev of provider.streamEvents(handle)) events.push(ev);
		expect(events).toEqual([]);
	});
});
