import { describe, expect, test } from "bun:test";
import { bindBridgeLogger, NOOP_BRIDGE_LOGGER } from "./logger.ts";
import type { BridgeLogger } from "./types.ts";

interface Recorded {
	bindings: object;
	calls: { level: string; obj: object; msg?: string }[];
}

/** Recording logger mirroring pino's `child` binding semantics. */
function makeRecordingLogger(): { logger: BridgeLogger; recorded: Recorded } {
	const recorded: Recorded = { bindings: {}, calls: [] };
	const make = (bindings: object): BridgeLogger => ({
		info: (obj, msg) => recorded.calls.push({ level: "info", obj, msg }),
		warn: (obj, msg) => recorded.calls.push({ level: "warn", obj, msg }),
		error: (obj, msg) => recorded.calls.push({ level: "error", obj, msg }),
		child(next) {
			recorded.bindings = { ...recorded.bindings, ...next };
			return make({ ...bindings, ...next });
		},
	});
	return { logger: make({}), recorded };
}

describe("bindBridgeLogger", () => {
	test("binds run_id and burrow_run_id via child once", () => {
		const { logger, recorded } = makeRecordingLogger();
		const log = bindBridgeLogger(logger, { run_id: "run_1", burrow_run_id: "br_1" });
		log.info({ event: "bridge.stalled" }, "stalled");
		expect(recorded.bindings).toEqual({ run_id: "run_1", burrow_run_id: "br_1" });
		expect(recorded.calls).toHaveLength(1);
		expect(recorded.calls[0]).toMatchObject({ level: "info", obj: { event: "bridge.stalled" } });
	});

	test("drops undefined binding values so worker is omitted", () => {
		const { logger, recorded } = makeRecordingLogger();
		bindBridgeLogger(logger, { run_id: "run_1" });
		expect(recorded.bindings).toEqual({ run_id: "run_1" });
		expect(Object.keys(recorded.bindings)).not.toContain("worker");
	});

	test("includes worker when supplied", () => {
		const { logger, recorded } = makeRecordingLogger();
		bindBridgeLogger(logger, { run_id: "run_1", burrow_run_id: "br_1", worker: "alpha" });
		expect(recorded.bindings).toEqual({
			run_id: "run_1",
			burrow_run_id: "br_1",
			worker: "alpha",
		});
	});

	test("falls back to the no-op logger when none supplied", () => {
		const log = bindBridgeLogger(undefined, { run_id: "run_1" });
		// Must not throw and must expose non-optional methods.
		expect(() => log.info({ event: "x" }, "msg")).not.toThrow();
		expect(() => log.warn({ event: "x" })).not.toThrow();
		expect(() => log.error({ event: "x" })).not.toThrow();
	});

	test("a partial logger without child still logs unconditionally", () => {
		const calls: string[] = [];
		const partial: BridgeLogger = { info: () => calls.push("info") };
		const log = bindBridgeLogger(partial, { run_id: "run_1" });
		log.info({ event: "x" });
		log.warn({ event: "x" }); // no-op (missing on source) — must not throw
		log.error({ event: "x" }); // no-op — must not throw
		expect(calls).toEqual(["info"]);
	});

	test("NOOP_BRIDGE_LOGGER.child returns a usable logger", () => {
		const child = NOOP_BRIDGE_LOGGER.child?.({ run_id: "x" });
		expect(child).toBeDefined();
		expect(() => child?.info?.({}, "noop")).not.toThrow();
	});
});
