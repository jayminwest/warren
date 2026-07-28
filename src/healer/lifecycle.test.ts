import { describe, expect, test } from "bun:test";
import {
	LifecycleBus,
	type RunDispatchedPayload,
	WARREN_EXT_PROTOCOL,
} from "../runs/lifecycle-bus.ts";
import { HEALER_TRIGGER } from "./index.ts";
import { createHealerLifecycleExtension } from "./lifecycle.ts";

interface LoggedLine {
	readonly obj: Record<string, unknown>;
	readonly msg?: string;
}

function recordingLogger() {
	const lines: LoggedLine[] = [];
	return {
		lines,
		logger: { info: (obj: Record<string, unknown>, msg?: string) => void lines.push({ obj, msg }) },
	};
}

function dispatched(overrides: Partial<RunDispatchedPayload> = {}): RunDispatchedPayload {
	return {
		runId: "run_1",
		projectId: "proj_1",
		agentName: "healer",
		branch: "burrow/run_1",
		trigger: HEALER_TRIGGER,
		sandboxId: "sbx_1",
		providerRunId: "brun_1",
		...overrides,
	};
}

describe("createHealerLifecycleExtension", () => {
	test("negotiates the warren-ext/v1 protocol and subscribes to run_dispatched", () => {
		const { logger } = recordingLogger();
		const ext = createHealerLifecycleExtension({ logger });
		expect(ext.name).toBe("healer");
		expect(ext.protocol).toBe(WARREN_EXT_PROTOCOL);
		expect(Object.keys(ext.hooks)).toEqual(["run_dispatched"]);
	});

	test("logs healer.dispatched for a healer-triggered run", () => {
		const { lines, logger } = recordingLogger();
		const bus = new LifecycleBus();
		bus.register(createHealerLifecycleExtension({ logger }));
		bus.emitRunDispatched(dispatched({ runId: "run_heal" }));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.msg).toBe("healer.dispatched");
		expect(lines[0]?.obj.runId).toBe("run_heal");
		expect(lines[0]?.obj.projectId).toBe("proj_1");
	});

	test("ignores runs dispatched by any other trigger", () => {
		const { lines, logger } = recordingLogger();
		const bus = new LifecycleBus();
		bus.register(createHealerLifecycleExtension({ logger }));
		bus.emitRunDispatched(dispatched({ trigger: "manual" }));
		bus.emitRunDispatched(dispatched({ trigger: "scheduled" }));
		expect(lines).toHaveLength(0);
	});

	test("registers on the bus without throwing (observe-only handshake)", () => {
		const { logger } = recordingLogger();
		const bus = new LifecycleBus();
		expect(() => bus.register(createHealerLifecycleExtension({ logger }))).not.toThrow();
		expect(bus.subscriberCount("run_dispatched")).toBe(1);
	});
});
