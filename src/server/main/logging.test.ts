/**
 * Unit tests for the pino → narrow logger adapters in `./logging.ts`
 * (warren-8d3d / pl-9088 step 10). The adapters are trivial
 * pass-throughs; this test locks the call-forwarding shape so the
 * structural subtype each subsystem (bridges, probe, scheduler,
 * plan-run coordinator, pause detector, preview eviction) declares
 * stays satisfied.
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../types.ts";
import {
	bridgeLoggerFromPino,
	pauseLoggerFromPino,
	planRunLoggerFromPino,
	previewEvictionLoggerFromPino,
	probeLoggerFromPino,
	schedulerLoggerFromPino,
} from "./logging.ts";

function makeRecorder(): {
	logger: Logger;
	calls: Array<{ level: string; obj: object; msg: string | undefined }>;
} {
	const calls: Array<{ level: string; obj: object; msg: string | undefined }> = [];
	const record =
		(level: string) =>
		(obj: object, msg?: string): void => {
			calls.push({ level, obj, msg });
		};
	const logger: Logger = {
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		debug: record("debug"),
	} as Logger;
	return { logger, calls };
}

describe("bridgeLoggerFromPino", () => {
	test("forwards info/warn/error to pino with the same args", () => {
		const { logger, calls } = makeRecorder();
		const adapter = bridgeLoggerFromPino(logger);
		adapter.info?.({ a: 1 }, "hi");
		adapter.warn?.({ b: 2 });
		adapter.error?.({ c: 3 }, "fail");
		expect(calls).toEqual([
			{ level: "info", obj: { a: 1 }, msg: "hi" },
			{ level: "warn", obj: { b: 2 }, msg: undefined },
			{ level: "error", obj: { c: 3 }, msg: "fail" },
		]);
	});
});

describe("probeLoggerFromPino", () => {
	test("forwards all four levels (info/warn/error/debug)", () => {
		const { logger, calls } = makeRecorder();
		const adapter = probeLoggerFromPino(logger);
		adapter.info({ a: 1 });
		adapter.warn({ b: 2 });
		adapter.error({ c: 3 });
		adapter.debug?.({ d: 4 }, "dbg");
		expect(calls.map((c) => c.level)).toEqual(["info", "warn", "error", "debug"]);
		expect(calls[3]?.msg).toBe("dbg");
	});

	test("debug is a no-op when the underlying logger has no debug method", () => {
		const adapter = probeLoggerFromPino({
			info: () => {},
			warn: () => {},
			error: () => {},
		} as unknown as Logger);
		// `debug?` is an optional method — when source logger lacks it,
		// calling through is still safe via optional chaining.
		expect(() => adapter.debug?.({ d: 1 })).not.toThrow();
	});
});

describe("schedulerLoggerFromPino / planRunLoggerFromPino / pauseLoggerFromPino / previewEvictionLoggerFromPino", () => {
	const factories = {
		scheduler: schedulerLoggerFromPino,
		planRun: planRunLoggerFromPino,
		pause: pauseLoggerFromPino,
		previewEviction: previewEvictionLoggerFromPino,
	} as const;

	test("each adapter forwards info/warn/error to the pino logger", () => {
		for (const [name, factory] of Object.entries(factories)) {
			const { logger, calls } = makeRecorder();
			const adapter = factory(logger);
			adapter.info({ from: name }, "i");
			adapter.warn({ from: name }, "w");
			adapter.error({ from: name }, "e");
			expect(calls.map((c) => c.level)).toEqual(["info", "warn", "error"]);
			expect(calls.every((c) => (c.obj as { from: string }).from === name)).toBe(true);
		}
	});
});
