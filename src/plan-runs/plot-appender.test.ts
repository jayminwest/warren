/**
 * Unit tests for the `plan_run_dispatched` Plot append helper
 * (warren-b89f / pl-7937 step 4). Covers the best-effort wrapper's
 * fire-and-log posture; the appender's own retry-on-rebuild loop is
 * exercised against a stub at this seam — the live `UserPlotClient`
 * round-trip is asserted by scenario 27 (warren-97a3).
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../server/types.ts";
import {
	type ActivatePlanRunPlotInput,
	type AppendPlanRunDispatchedInput,
	emitPlanRunDispatchedToPlot,
	type PlanRunPlotActivationResult,
	type PlanRunPlotActivator,
	type PlanRunPlotAppender,
	promotePlotToActiveOnDispatch,
} from "./plot-appender.ts";

interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

function makeLogger(captured: CapturedLog[]): Logger {
	return {
		info(obj, msg) {
			captured.push({ level: "info", obj, msg });
		},
		warn(obj, msg) {
			captured.push({ level: "warn", obj, msg });
		},
		error(obj, msg) {
			captured.push({ level: "error", obj, msg });
		},
	};
}

function makeAppender(opts: {
	calls?: AppendPlanRunDispatchedInput[];
	throws?: Error;
}): PlanRunPlotAppender {
	const calls = opts.calls ?? [];
	return {
		async appendPlanRunDispatched(input) {
			calls.push(input);
			if (opts.throws) throw opts.throws;
		},
	};
}

describe("emitPlanRunDispatchedToPlot", () => {
	test("forwards the input through to the appender on success", async () => {
		const calls: AppendPlanRunDispatchedInput[] = [];
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ calls }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 4,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 4,
		});
		expect(captured.filter((c) => c.msg === "plan_run.plot_append_failed")).toHaveLength(0);
	});

	test("logs plan_run.plot_append_failed and swallows when the appender throws", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: makeAppender({ throws: new Error("boom") }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
			planId: "pl-x",
			childrenCount: 1,
		});
		const failure = captured.find((c) => c.msg === "plan_run.plot_append_failed");
		expect(failure).toBeDefined();
		expect(failure?.level).toBe("warn");
		const obj = failure?.obj as { planRunId?: string; plotId?: string; err?: string };
		expect(obj.planRunId).toBe("plr_1");
		expect(obj.plotId).toBe("plot_x");
		expect(obj.err).toBe("boom");
	});

	test("stringifies a non-Error throw value for the log payload", async () => {
		const captured: CapturedLog[] = [];
		await emitPlanRunDispatchedToPlot({
			appender: {
				async appendPlanRunDispatched() {
					throw "stringy failure";
				},
			},
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_y",
			handle: "operator",
			planRunId: "plr_2",
			planId: "pl-y",
			childrenCount: 0,
		});
		const failure = captured.find((c) => c.msg === "plan_run.plot_append_failed");
		expect(failure).toBeDefined();
		expect((failure?.obj as { err?: string }).err).toBe("stringy failure");
	});
});

function makeActivator(opts: {
	calls?: ActivatePlanRunPlotInput[];
	result?: PlanRunPlotActivationResult;
	throws?: unknown;
}): PlanRunPlotActivator {
	const calls = opts.calls ?? [];
	return {
		async activatePlanRunPlot(input) {
			calls.push(input);
			if (opts.throws !== undefined) throw opts.throws;
			return opts.result ?? { kind: "activated", previousStatus: "ready" };
		},
	};
}

describe("promotePlotToActiveOnDispatch", () => {
	test("forwards input and logs plan_run.plot_activated on transition", async () => {
		const calls: ActivatePlanRunPlotInput[] = [];
		const captured: CapturedLog[] = [];
		const result = await promotePlotToActiveOnDispatch({
			activator: makeActivator({ calls }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "activated", previousStatus: "ready" });
		expect(calls[0]).toEqual({ plotDir: "/tmp/p/.plot", plotId: "plot_x", handle: "alice" });
		const log = captured.find((c) => c.msg === "plan_run.plot_activated");
		expect(log?.level).toBe("info");
	});

	test("logs plan_run.plot_activation_skipped when status is not ready", async () => {
		const captured: CapturedLog[] = [];
		const result = await promotePlotToActiveOnDispatch({
			activator: makeActivator({ result: { kind: "skipped", currentStatus: "drafting" } }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "skipped", currentStatus: "drafting" });
		const log = captured.find((c) => c.msg === "plan_run.plot_activation_skipped");
		expect(log?.level).toBe("warn");
		expect((log?.obj as { currentStatus?: string }).currentStatus).toBe("drafting");
	});

	test("logs plan_run.plot_activation_failed and swallows when activator throws", async () => {
		const captured: CapturedLog[] = [];
		const result = await promotePlotToActiveOnDispatch({
			activator: makeActivator({ throws: new Error("boom") }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_x",
			handle: "alice",
			planRunId: "plr_1",
		});
		expect(result).toEqual({ kind: "failed", reason: "boom" });
		const log = captured.find((c) => c.msg === "plan_run.plot_activation_failed");
		expect(log?.level).toBe("warn");
		expect((log?.obj as { err?: string }).err).toBe("boom");
	});

	test("stringifies a non-Error throw value for the failure log", async () => {
		const captured: CapturedLog[] = [];
		const result = await promotePlotToActiveOnDispatch({
			activator: makeActivator({ throws: "stringy" }),
			logger: makeLogger(captured),
			plotDir: "/tmp/p/.plot",
			plotId: "plot_y",
			handle: "op",
			planRunId: "plr_2",
		});
		expect(result).toEqual({ kind: "failed", reason: "stringy" });
		const log = captured.find((c) => c.msg === "plan_run.plot_activation_failed");
		expect((log?.obj as { err?: string }).err).toBe("stringy");
	});
});
