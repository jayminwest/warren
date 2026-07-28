import { describe, expect, test } from "bun:test";
import {
	type BranchPushedPayload,
	type EventEmittedPayload,
	LIFECYCLE_HOOKS,
	LifecycleBus,
	type LifecycleEnvelope,
	type LifecycleExtension,
	type LifecycleHook,
	type PostReapPayload,
	type PreReapPayload,
	type RunDispatchedPayload,
	type RunStartedPayload,
	registerExtensions,
	WARREN_EXT_PROTOCOL,
} from "./lifecycle-bus.ts";

const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

function busWithClock() {
	return new LifecycleBus({ now: () => FIXED_NOW });
}

function dispatchedPayload(runId = "run_1"): RunDispatchedPayload {
	return {
		runId,
		projectId: "proj_1",
		agentName: "claude-code",
		branch: "burrow/run_1",
		trigger: "manual",
		sandboxId: "sbx_1",
		providerRunId: "brun_1",
	};
}

describe("LifecycleBus.register", () => {
	test("rejects a protocol handshake mismatch", () => {
		const bus = busWithClock();
		expect(() =>
			bus.register({
				name: "bad",
				// biome-ignore lint/suspicious/noExplicitAny: exercising a runtime handshake failure
				protocol: "warren-ext/v2" as any,
				hooks: { run_dispatched: () => {} },
			}),
		).toThrow(/warren-ext\/v1/);
	});

	test("rejects an extension that subscribes to no hooks", () => {
		const bus = busWithClock();
		expect(() => bus.register({ name: "empty", protocol: WARREN_EXT_PROTOCOL, hooks: {} })).toThrow(
			/no hooks/,
		);
	});

	test("rejects an unknown hook name", () => {
		const bus = busWithClock();
		expect(() =>
			bus.register({
				name: "typo",
				protocol: WARREN_EXT_PROTOCOL,
				// biome-ignore lint/suspicious/noExplicitAny: exercising an unknown-hook runtime guard
				hooks: { not_a_hook: () => {} } as any,
			}),
		).toThrow(/unknown hook/);
	});

	test("subscriberCount and extensionNames reflect registration and unregister", () => {
		const bus = busWithClock();
		const reg = bus.register({
			name: "counter",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: { run_dispatched: () => {}, post_reap: () => {} },
		});
		expect(bus.subscriberCount("run_dispatched")).toBe(1);
		expect(bus.subscriberCount("post_reap")).toBe(1);
		expect(bus.subscriberCount("branch_pushed")).toBe(0);
		expect(bus.extensionNames()).toEqual(["counter"]);
		reg.unregister();
		expect(bus.subscriberCount("run_dispatched")).toBe(0);
		expect(bus.extensionNames()).toEqual([]);
	});
});

describe("LifecycleBus.emit — payload shapes", () => {
	test("every hook stamps warren-ext/v1 and an ISO timestamp", () => {
		const bus = busWithClock();
		const seen: LifecycleEnvelope[] = [];
		const hooks: LifecycleExtension["hooks"] = {};
		for (const hook of LIFECYCLE_HOOKS) {
			// biome-ignore lint/suspicious/noExplicitAny: uniform capture across the hook union
			(hooks as any)[hook] = (env: LifecycleEnvelope) => seen.push(env);
		}
		bus.register({ name: "observer", protocol: WARREN_EXT_PROTOCOL, hooks });

		bus.emitRunDispatched(dispatchedPayload());
		bus.emitRunStarted({ runId: "run_1" } satisfies RunStartedPayload);
		bus.emitEventEmitted({
			runId: "run_1",
			seq: 3,
			kind: "text",
			stream: "stdout",
		} satisfies EventEmittedPayload);
		bus.emitPreReap({
			runId: "run_1",
			projectId: "proj_1",
			outcome: "succeeded",
		} satisfies PreReapPayload);
		bus.emitPostReap({
			runId: "run_1",
			projectId: "proj_1",
			outcome: "succeeded",
			branchPushed: true,
			commitsAhead: 2,
			prUrl: null,
		} satisfies PostReapPayload);
		bus.emitBranchPushed({
			runId: "run_1",
			branch: "burrow/run_1",
			baseBranch: "main",
			commitsAhead: 2,
		} satisfies BranchPushedPayload);

		expect(seen.map((e) => e.hook)).toEqual([...LIFECYCLE_HOOKS]);
		for (const env of seen) {
			expect(env.protocol).toBe(WARREN_EXT_PROTOCOL);
			expect(env.at).toBe(FIXED_NOW.toISOString());
			expect(env.runId).toBe("run_1");
		}
	});

	test("delivers only to subscribers of the emitted hook", () => {
		const bus = busWithClock();
		const dispatched: string[] = [];
		const reaped: string[] = [];
		bus.register({
			name: "a",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				run_dispatched: (e) => {
					dispatched.push(e.payload.runId);
				},
			},
		});
		bus.register({
			name: "b",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				post_reap: (e) => {
					reaped.push(e.payload.runId);
				},
			},
		});
		bus.emitRunDispatched(dispatchedPayload("run_x"));
		expect(dispatched).toEqual(["run_x"]);
		expect(reaped).toEqual([]);
	});

	test("emit with no subscribers is a no-op and never throws", () => {
		const bus = busWithClock();
		expect(() => bus.emitRunStarted({ runId: "run_1" })).not.toThrow();
	});
});

describe("LifecycleBus — observe-only isolation", () => {
	test("payload and envelope are frozen (subscribers cannot mutate run flow)", () => {
		const bus = busWithClock();
		let captured: LifecycleEnvelope<"run_dispatched"> | null = null;
		bus.register({
			name: "mutator",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				run_dispatched: (env) => {
					captured = env;
				},
			},
		});
		bus.emitRunDispatched(dispatchedPayload());
		expect(captured).not.toBeNull();
		const env = captured as unknown as LifecycleEnvelope<"run_dispatched">;
		expect(Object.isFrozen(env)).toBe(true);
		expect(Object.isFrozen(env.payload)).toBe(true);
	});

	test("a throwing sync subscriber is isolated and routed to onError", () => {
		const errors: Array<{ extension: string; hook: LifecycleHook }> = [];
		const bus = new LifecycleBus({
			now: () => FIXED_NOW,
			onError: ({ extension, hook }) => errors.push({ extension, hook }),
		});
		const other: string[] = [];
		bus.register({
			name: "boom",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				run_dispatched: () => {
					throw new Error("nope");
				},
			},
		});
		bus.register({
			name: "survivor",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				run_dispatched: (e) => {
					other.push(e.payload.runId);
				},
			},
		});
		expect(() => bus.emitRunDispatched(dispatchedPayload("run_y"))).not.toThrow();
		expect(other).toEqual(["run_y"]);
		expect(errors).toEqual([{ extension: "boom", hook: "run_dispatched" }]);
	});

	test("a rejecting async subscriber is isolated and routed to onError", async () => {
		const errors: unknown[] = [];
		const bus = new LifecycleBus({
			now: () => FIXED_NOW,
			onError: ({ error }) => errors.push(error),
		});
		bus.register({
			name: "async-boom",
			protocol: WARREN_EXT_PROTOCOL,
			hooks: {
				post_reap: async () => {
					throw new Error("async nope");
				},
			},
		});
		bus.emitPostReap({
			runId: "run_1",
			projectId: "proj_1",
			outcome: "failed",
			branchPushed: false,
			commitsAhead: null,
			prUrl: null,
		});
		// Let the detached rejection settle.
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("async nope");
	});
});

describe("registerExtensions", () => {
	test("registers a batch and unregisterAll detaches them together", () => {
		const bus = busWithClock();
		const extensions: LifecycleExtension[] = [
			{ name: "one", protocol: WARREN_EXT_PROTOCOL, hooks: { run_dispatched: () => {} } },
			{ name: "two", protocol: WARREN_EXT_PROTOCOL, hooks: { branch_pushed: () => {} } },
		];
		const { unregisterAll } = registerExtensions(bus, extensions);
		expect(bus.extensionNames().sort()).toEqual(["one", "two"]);
		unregisterAll();
		expect(bus.extensionNames()).toEqual([]);
	});
});
