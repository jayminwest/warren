import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type {
	FinalizeResult,
	Message,
	NormalizedEvent,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	TeardownResult,
	WorkspaceInfo,
} from "../../runtime/contract.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { seedBridgeRun } from "./test-helpers.ts";

/**
 * OOM propagation (warren-9cce / warren-1f56). Burrow already emits an OOM
 * signal that warren historically collapsed into an anonymous error. With the
 * run-state poller reading `provider.status()`, an OOM-killed run surfaces
 * `terminalReason:"oom_killed"`, which the poller distills into a
 * `failure_reason` and the bridge carries onto `terminalDetected` for reap.
 *
 * This drives the REAL provider-default path (no `source`/`runStateProbe`
 * override): an injected `RuntimeProvider` whose stream idles like burrow's
 * infinite tail and whose `status()` reports the OOM kill. It exercises the
 * signal-adapting `providerStreamSource`, `defaultRunStateProbe(provider)`, the
 * poller's OOM distillation, and the terminal synthesis in one pass.
 */

const CAPABILITIES: RuntimeCapabilities = {
	previewPorts: true,
	networkPolicy: "domain-allowlist",
	longLived: true,
	midRunSteering: true,
	enforcedResourceLimits: true,
	workspaceArchive: true,
	workspaceGc: true,
};

/** A provider whose stream tails forever (until torn down) and whose status is fixed. */
class FakeRuntimeProvider implements RuntimeProvider {
	readonly capabilities = CAPABILITIES;
	readonly kind = "local" as const;
	constructor(private readonly fixedStatus: RunStatus) {}

	create(_spec: RunSpec): Promise<RunHandle> {
		throw new Error("unused");
	}

	streamEvents(_handle: RunHandle): AsyncIterable<NormalizedEvent> {
		return (async function* () {
			let i = 1;
			// A killed agent's burrow stream keeps tailing (never auto-closes) until
			// the poller aborts it — mirror that so the poller path drives terminal.
			for (;;) {
				yield {
					seq: i,
					ts: new Date(2026, 4, 8, 12, 0, i).toISOString(),
					kind: "text",
					stream: "stdout",
					payload: { text: `line ${i}` },
				} satisfies NormalizedEvent;
				i += 1;
				await new Promise((r) => setTimeout(r, 2));
			}
		})();
	}

	status(_handle: RunHandle): Promise<RunStatus> {
		return Promise.resolve(this.fixedStatus);
	}

	sendMessage(_handle: RunHandle): Promise<Message> {
		throw new Error("unused");
	}

	cancel(_handle: RunHandle): Promise<void> {
		return Promise.resolve();
	}

	workspaceInfo(_handle: RunHandle): Promise<WorkspaceInfo> {
		throw new Error("unused");
	}

	finalize(_handle: RunHandle): Promise<FinalizeResult> {
		throw new Error("unused");
	}

	terminate(_handle: RunHandle): Promise<TeardownResult> {
		throw new Error("unused");
	}
}

describe("bridgeRunStream — OOM propagation (warren-9cce)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let sandboxRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		sandboxRunId = ids.sandboxRunId;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("carries oom_killed from provider.status onto terminalDetected", async () => {
		const provider = new FakeRuntimeProvider({
			phase: "failed",
			exitCode: 137,
			terminalReason: "oom_killed",
			lastEventSeq: 3,
			lastEventTs: "2026-05-08T12:00:03.000Z",
			exists: true,
		});

		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});

		expect(result.terminalDetected).toEqual({ outcome: "failed", failureReason: "oom_killed" });
		expect(result.errored).toBe(false);
		expect(result.sandboxRunMissing).toBeUndefined();
		// Events streamed through the seam were persisted (proves the provider
		// source pumped, not just the poller).
		expect(result.written).toBeGreaterThan(0);
	});

	test("a non-OOM failure carries no failureReason (reap infers it)", async () => {
		const provider = new FakeRuntimeProvider({
			phase: "failed",
			exitCode: 1,
			terminalReason: "error",
			lastEventSeq: 1,
			lastEventTs: "2026-05-08T12:00:01.000Z",
			exists: true,
		});

		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});

		expect(result.terminalDetected).toEqual({ outcome: "failed" });
	});

	// warren-c0cd: an evicted pod (ephemeral-storage exhaustion) must reconcile the
	// run to a terminal failed/evicted — not hang `running` until a manual cancel.
	test("carries evicted from provider.status onto terminalDetected", async () => {
		const provider = new FakeRuntimeProvider({
			phase: "failed",
			exitCode: 137,
			terminalReason: "evicted",
			lastEventSeq: 3,
			lastEventTs: "2026-05-08T12:00:03.000Z",
			exists: true,
		});

		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});

		expect(result.terminalDetected).toEqual({ outcome: "failed", failureReason: "evicted" });
		expect(result.errored).toBe(false);
		expect(result.sandboxRunMissing).toBeUndefined();
	});
});
