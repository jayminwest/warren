import { describe, expect, test } from "bun:test";
import { promptTitle, runTitle } from "./run-title.ts";

describe("promptTitle", () => {
	test("collapses the tracker prompt shape and passes others through", () => {
		expect(promptTitle('Work GitHub issue #1230 in jayminwest/warren: "version bump drift"')).toBe(
			"#1230 version bump drift",
		);
		expect(promptTitle("Fix the flaky test")).toBe("Fix the flaky test");
	});
});

describe("runTitle", () => {
	test("falls back to the seed id, then the agent", () => {
		expect(runTitle({ prompt: "", seedId: "warren-1234", agentName: "pi" })).toBe("warren-1234");
		expect(runTitle({ prompt: "  ", seedId: null, agentName: "pi" })).toBe("pi");
	});
});
