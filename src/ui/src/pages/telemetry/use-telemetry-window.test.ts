import { describe, expect, test } from "bun:test";
import { telemetryAnalyticsFilter, telemetryQueryKey } from "./telemetry-window.helpers.ts";

describe("telemetry window helpers", () => {
	test("telemetryAnalyticsFilter omits projectId when unset", () => {
		expect(telemetryAnalyticsFilter(null, "f", "t")).toEqual({ from: "f", to: "t" });
	});

	test("telemetryAnalyticsFilter threads a selected projectId through", () => {
		expect(telemetryAnalyticsFilter("proj-1", "f", "t")).toEqual({
			projectId: "proj-1",
			from: "f",
			to: "t",
		});
	});

	test("telemetryQueryKey scopes both tab queries by projectId", () => {
		expect(telemetryQueryKey("runs", null, "f", "t")).toEqual([
			"analytics",
			"runs",
			{ projectId: null, from: "f", to: "t" },
		]);
		expect(telemetryQueryKey("behavior", "proj-1", "f", "t")).toEqual([
			"analytics",
			"behavior",
			{ projectId: "proj-1", from: "f", to: "t" },
		]);
	});
});
