import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import {
	clearLifecycleBus,
	type EventEmittedPayload,
	installLifecycleBus,
	LifecycleBus,
	type RunStartedPayload,
} from "../lifecycle-bus.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makeProvider, seedBridgeRun, source } from "./test-helpers.ts";

/**
 * warren-28ca: the event bridge is the production emit site for the
 * `run_started` (queued → running claim) and `event_emitted` (one
 * persisted row, mirror of `broker.publish`) lifecycle hooks. Prior to
 * this both hooks were declared in `warren-ext/v1` but never fired on
 * any production path.
 */

describe("bridgeRunStream — lifecycle emits (warren-28ca)", () => {
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
		clearLifecycleBus();
		await db.close();
	});

	function spy(): {
		bus: LifecycleBus;
		started: RunStartedPayload[];
		emitted: EventEmittedPayload[];
	} {
		const started: RunStartedPayload[] = [];
		const emitted: EventEmittedPayload[] = [];
		const bus = new LifecycleBus();
		bus.register({
			name: "spy",
			protocol: "warren-ext/v1",
			hooks: {
				run_started: (env) => void started.push(env.payload),
				event_emitted: (env) => void emitted.push(env.payload),
			},
		});
		return { bus, started, emitted };
	}

	test("emits run_started once on the queued → running claim", async () => {
		const { bus, started } = spy();
		installLifecycleBus(bus);

		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1), evt(sandboxRunId, 2), evt(sandboxRunId, 3)]),
		});

		expect(started).toHaveLength(1);
		expect(started[0]?.runId).toBe(runId);
	});

	test("emits event_emitted once per persisted row after the broker publish", async () => {
		const { bus, emitted } = spy();
		installLifecycleBus(bus);

		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1), evt(sandboxRunId, 2), evt(sandboxRunId, 3)]),
		});

		expect(emitted.map((p) => p.seq)).toEqual([1, 2, 3]);
		for (const payload of emitted) {
			expect(payload.runId).toBe(runId);
			expect(typeof payload.kind).toBe("string");
			expect(typeof payload.stream).toBe("string");
		}
	});

	test("no installed bus ⇒ emits are a pure no-op", async () => {
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1)]),
		});
		expect(result.written).toBe(1);
	});
});
