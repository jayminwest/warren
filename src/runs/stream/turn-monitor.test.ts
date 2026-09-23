import { describe, expect, test } from "bun:test";
import { piMessageDelta, piTurnEnd, piTurnStart } from "./test-helpers.ts";
import {
	DEFAULT_TURN_DEGENERATE_MIN_BYTES,
	DEFAULT_TURN_DEGENERATE_MIN_DELTAS,
	DEFAULT_TURN_STALL_MS,
	type TurnClock,
	TurnMonitor,
	type TurnMonitorOptions,
	turnMonitorOptionsFromEnv,
} from "./turn-monitor.ts";

/** Manual clock — the test advances wall time without sleeping. */
class FakeClock implements TurnClock {
	nowMs = 0;
	now(): number {
		return this.nowMs;
	}
	advance(ms: number): void {
		this.nowMs += ms;
	}
}

function makeMonitor(
	overrides: Partial<TurnMonitorOptions> = {},
	clock = new FakeClock(),
): TurnMonitor {
	return new TurnMonitor({
		stallMs: 1_000,
		stallCheckIntervalMs: 5,
		degenerateMinDeltas: 3,
		degenerateMinBytes: null,
		costCapUsd: null,
		clock,
		...overrides,
	});
}

describe("turnMonitorOptionsFromEnv", () => {
	test("falls back to the built-in defaults when nothing is set", () => {
		const options = turnMonitorOptionsFromEnv({}, null);
		expect(options.stallMs).toBe(DEFAULT_TURN_STALL_MS);
		expect(options.degenerateMinDeltas).toBe(DEFAULT_TURN_DEGENERATE_MIN_DELTAS);
		expect(options.degenerateMinBytes).toBe(DEFAULT_TURN_DEGENERATE_MIN_BYTES);
		expect(options.costCapUsd).toBeNull();
	});

	test("disables an arm when the knob is pinned to 0 and threads the spend cap", () => {
		const options = turnMonitorOptionsFromEnv(
			{ WARREN_TURN_STALL_MS: "0", WARREN_TURN_DEGENERATE_MIN_DELTAS: "5" },
			2.5,
		);
		expect(options.stallMs).toBeNull();
		expect(options.degenerateMinDeltas).toBe(5);
		expect(options.costCapUsd).toBe(2.5);
	});

	test("throws on a malformed value so a deploy-config typo fails loud", () => {
		expect(() => turnMonitorOptionsFromEnv({ WARREN_TURN_STALL_MS: "soon" }, null)).toThrow();
	});
});

describe("TurnMonitor", () => {
	test("trips degeneration on the byte threshold alone", () => {
		const monitor = makeMonitor({ degenerateMinDeltas: null, degenerateMinBytes: 6 });
		expect(monitor.observe(piTurnStart("run", 1))).toBeNull();
		expect(monitor.observe(piMessageDelta("run", 2, { delta: "    " }))).toBeNull();
		const trip = monitor.observe(piMessageDelta("run", 3, { delta: "  \n\t" }));
		expect(trip).toMatchObject({ kind: "degenerate", deltaCount: 2, byteCount: 8 });
	});

	test("ignores non-update envelopes and non-delta update events", () => {
		const monitor = makeMonitor({ degenerateMinDeltas: 1 });
		expect(monitor.observe(piTurnStart("run", 1))).toBeNull();
		// message_end-shaped / unknown payloads carry no delta to count.
		const skeleton = piMessageDelta("run", 2, { delta: " " });
		(skeleton.payload as { assistantMessageEvent: unknown }).assistantMessageEvent = {
			type: "thinking_start",
			contentIndex: 0,
		};
		expect(monitor.observe(skeleton)).toBeNull();
		expect(monitor.observe(piTurnEnd("run", 3, { input: 1, output: 1, costTotal: 0 }))).toBeNull();
	});

	test("accounts cumulative spend across turn_end totals and in-flight partials", () => {
		const monitor = makeMonitor({ costCapUsd: 5 });
		expect(monitor.cumulativeCostUsd()).toBeNull();
		monitor.observe(piTurnStart("run", 1));
		monitor.observe(piMessageDelta("run", 2, { delta: "a", costTotal: 0.4 }));
		expect(monitor.cumulativeCostUsd()).toBe(0.4);
		// turn_end's authoritative total replaces the partial, then a new turn
		// starts accruing on top of it.
		monitor.observe(piTurnEnd("run", 3, { input: 1, output: 1, costTotal: 0.5 }));
		expect(monitor.cumulativeCostUsd()).toBe(0.5);
		monitor.observe(piTurnStart("run", 4));
		monitor.observe(piMessageDelta("run", 5, { delta: "b", costTotal: 0.2 }));
		expect(monitor.cumulativeCostUsd()).toBe(0.7);
		monitor.observe(piTurnEnd("run", 6, { input: 1, output: 1, costTotal: 0.3 }));
		expect(monitor.cumulativeCostUsd()).toBe(0.8);
	});

	test("trips spend only past the cap (strict-greater)", () => {
		const monitor = makeMonitor({ costCapUsd: 1 });
		monitor.observe(piTurnStart("run", 1));
		expect(monitor.observe(piMessageDelta("run", 2, { delta: "a", costTotal: 1 }))).toBeNull();
		const trip = monitor.observe(piMessageDelta("run", 3, { delta: "b", costTotal: 1.01 }));
		expect(trip).toMatchObject({ kind: "spend", costUsd: 1.01, capUsd: 1 });
	});

	test("fires the stall timer only while a turn is open, and only once", async () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: 1_000, stallCheckIntervalMs: 2 }, clock);
		const stalled: unknown[] = [];
		monitor.start((trip) => stalled.push(trip));
		// Idle before any turn_start never trips (watchdog owns run-start idle).
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(0);

		monitor.observe(piTurnStart("run", 1));
		clock.advance(1_500);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(1);
		expect(stalled[0]).toMatchObject({ kind: "stalled", idleMs: 1_500, stallMs: 1_000 });
		// Tripped once: the timer disarmed itself.
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(1);
		monitor.stop();
	});

	test("stop() disarms the stall timer", async () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: 1_000, stallCheckIntervalMs: 2 }, clock);
		const stalled: unknown[] = [];
		monitor.observe(piTurnStart("run", 1));
		monitor.start((trip) => stalled.push(trip));
		monitor.stop();
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(0);
	});

	test("start() is a no-op when stall detection is disabled", () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: null }, clock);
		const stalled: unknown[] = [];
		monitor.observe(piTurnStart("run", 1));
		monitor.start((trip) => stalled.push(trip));
		monitor.stop();
		clock.advance(5_000);
		expect(stalled).toHaveLength(0);
	});
});
