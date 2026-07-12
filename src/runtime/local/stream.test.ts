/**
 * `LocalProvider.streamEvents()` — the burrow run-event stream wrapped as the
 * seam's `NormalizedEvent` stream (pl-829f step 9). Drives the real body against
 * the established burrow-client fetch-stub fake (`src/runs/spawn/test-helpers.ts`)
 * so the NDJSON source, seq passthrough, lossless payload, resume dedup, and
 * abort-on-break are all exercised with no real socket.
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
import type { NormalizedEvent, RunHandle } from "../contract.ts";
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

async function drain(iter: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
	const out: NormalizedEvent[] = [];
	for await (const ev of iter) out.push(ev);
	return out;
}

describe("LocalProvider.streamEvents", () => {
	test("yields NormalizedEvents carrying burrow's native seq and ISO ts", async () => {
		const { provider, calls } = await localProvider({
			streamEvents: [
				{ seq: 1, kind: "log", stream: "stdout", ts: "2026-05-08T12:00:01.000Z" },
				{ seq: 2, kind: "state_change", stream: "system", ts: "2026-05-08T12:00:02.000Z" },
			],
		});
		const events = await drain(provider.streamEvents(HANDLE));
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		expect(events[0]?.ts).toBe("2026-05-08T12:00:01.000Z");
		expect(events[0]?.kind).toBe("log");
		expect(events[0]?.stream).toBe("stdout");
		expect(events[1]?.kind).toBe("state_change");
		expect(events[1]?.stream).toBe("system");
		// Sourced from burrow's run-scoped stream endpoint.
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /runs/run_zzzzzzzzzzzz/stream",
		]);
	});

	test("passes the payload through losslessly (no field-dropping)", async () => {
		const payload = {
			type: "result",
			total_cost_usd: 0.42,
			usage: { input_tokens: 10, output_tokens: 5, nested: { a: [1, 2, 3] } },
			extra: "keep me",
		};
		const { provider } = await localProvider({
			streamEvents: [{ seq: 7, kind: "state_change", payload }],
		});
		const events = await drain(provider.streamEvents(HANDLE));
		expect(events[0]?.payload).toEqual(payload);
	});

	test("coerces an unrecognized stream tag to null", async () => {
		const { provider } = await localProvider({
			streamEvents: [{ seq: 1, stream: "telemetry" }],
		});
		const events = await drain(provider.streamEvents(HANDLE));
		expect(events[0]?.stream).toBeNull();
	});

	test("resume via sinceSeq skips events at or below the cursor", async () => {
		const { provider } = await localProvider({
			streamEvents: [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }],
		});
		const events = await drain(provider.streamEvents(HANDLE, { sinceSeq: 2 }));
		expect(events.map((e) => e.seq)).toEqual([3, 4]);
	});

	test("sinceSeq undefined yields from the first event", async () => {
		const { provider } = await localProvider({ streamEvents: [{ seq: 1 }, { seq: 2 }] });
		const events = await drain(provider.streamEvents(HANDLE));
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});

	test("breaking out of the consumer terminates the stream cleanly", async () => {
		const { provider } = await localProvider({
			streamEvents: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
		});
		const seen: number[] = [];
		for await (const ev of provider.streamEvents(HANDLE)) {
			seen.push(ev.seq);
			if (ev.seq === 2) break; // triggers the generator's finally (abort + return)
		}
		expect(seen).toEqual([1, 2]);
	});

	test("an empty stream yields nothing", async () => {
		const { provider } = await localProvider({ streamEvents: [] });
		expect(await drain(provider.streamEvents(HANDLE))).toEqual([]);
	});
});
