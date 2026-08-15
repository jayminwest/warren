import { describe, expect, test } from "bun:test";
import { LifecycleBus } from "./lifecycle-bus.ts";
import {
	createLifecycleStreamExtension,
	LifecycleStreamBroker,
	type LifecycleStreamNotification,
} from "./lifecycle-stream.ts";

async function take(
	gen: AsyncGenerator<LifecycleStreamNotification, void, void>,
	n: number,
): Promise<LifecycleStreamNotification[]> {
	const out: LifecycleStreamNotification[] = [];
	for (let i = 0; i < n; i += 1) {
		const { value, done } = await gen.next();
		if (done) break;
		out.push(value);
	}
	return out;
}

describe("LifecycleStreamBroker", () => {
	test("fan out reaches every attached subscriber", async () => {
		const broker = new LifecycleStreamBroker();
		const a = broker.subscribe();
		const b = broker.subscribe();
		expect(broker.subscriberCount()).toBe(2);

		broker.publish({ runId: "r1", hook: "run_started", state: "running", ts: "t" });
		expect(await take(a, 1)).toEqual([
			{ runId: "r1", hook: "run_started", state: "running", ts: "t" },
		]);
		expect(await take(b, 1)).toEqual([
			{ runId: "r1", hook: "run_started", state: "running", ts: "t" },
		]);
	});

	test("publish with no subscribers is a no-op", () => {
		const broker = new LifecycleStreamBroker();
		expect(() =>
			broker.publish({ runId: "r1", hook: "run_started", state: "running", ts: "t" }),
		).not.toThrow();
	});

	test("abort signal ends the generator and detaches the subscription", async () => {
		const broker = new LifecycleStreamBroker();
		const ctrl = new AbortController();
		const gen = broker.subscribe({ signal: ctrl.signal });
		expect(broker.subscriberCount()).toBe(1);
		ctrl.abort();
		const { done } = await gen.next();
		expect(done).toBe(true);
		expect(broker.subscriberCount()).toBe(0);
	});

	test("breaking out of the generator detaches the subscription", async () => {
		const broker = new LifecycleStreamBroker();
		const gen = broker.subscribe();
		broker.publish({ runId: "r1", hook: "run_started", state: "running", ts: "t" });
		await gen.next();
		await gen.return(undefined);
		expect(broker.subscriberCount()).toBe(0);
	});

	test("a bounded queue drops FIFO on overflow", async () => {
		const broker = new LifecycleStreamBroker();
		const gen = broker.subscribe({ bufferSize: 2 });
		for (let i = 0; i < 4; i += 1) {
			broker.publish({ runId: `r${i}`, hook: "run_started", state: "running", ts: "t" });
		}
		const got = await take(gen, 2);
		expect(got.map((n) => n.runId)).toEqual(["r2", "r3"]);
	});
});

describe("createLifecycleStreamExtension", () => {
	test("projects lifecycle envelopes into slim notifications", async () => {
		const broker = new LifecycleStreamBroker();
		const bus = new LifecycleBus({ now: () => new Date("2026-08-01T00:00:00.000Z") });
		bus.register(createLifecycleStreamExtension(broker));
		const gen = broker.subscribe();

		bus.emitRunDispatched({
			runId: "r1",
			projectId: "p1",
			agentName: "pi",
			branch: "b",
			trigger: "manual",
			sandboxId: "s1",
			providerRunId: "pr1",
		});
		bus.emitRunStarted({ runId: "r1" });
		bus.emitPostReap({
			runId: "r1",
			projectId: "p1",
			outcome: "succeeded",
			branchPushed: true,
			commitsAhead: 2,
			prUrl: null,
		});
		bus.emitBranchPushed({ runId: "r1", branch: "b", baseBranch: "main", commitsAhead: 2 });

		const got = await take(gen, 4);
		expect(got).toEqual([
			{ runId: "r1", hook: "run_dispatched", state: "queued", ts: "2026-08-01T00:00:00.000Z" },
			{ runId: "r1", hook: "run_started", state: "running", ts: "2026-08-01T00:00:00.000Z" },
			{ runId: "r1", hook: "post_reap", state: "succeeded", ts: "2026-08-01T00:00:00.000Z" },
			{ runId: "r1", hook: "branch_pushed", state: null, ts: "2026-08-01T00:00:00.000Z" },
		]);
	});

	test("does not subscribe to event_emitted", () => {
		const broker = new LifecycleStreamBroker();
		const bus = new LifecycleBus();
		bus.register(createLifecycleStreamExtension(broker));
		expect(bus.subscriberCount("event_emitted")).toBe(0);
		expect(bus.subscriberCount("run_started")).toBe(1);
	});
});
