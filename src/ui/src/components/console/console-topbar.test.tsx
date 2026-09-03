import { describe, expect, test } from "bun:test";
import {
	burnValue,
	deriveBurnUsdPerHour,
	healthLabel,
	runtimeValue,
} from "./console-topbar.helpers.ts";

describe("healthLabel", () => {
	test("renders HEALTHY when the /healthz probe is ok", () => {
		expect(healthLabel("ok")).toBe("HEALTHY");
	});

	test("renders UNREACHABLE when the /healthz probe fails", () => {
		expect(healthLabel("down")).toBe("UNREACHABLE");
	});

	test("renders an em dash while the probe is unknown", () => {
		expect(healthLabel("unknown")).toBe("—");
	});

	test("label is a single spelling at every width (no CONTROL PLANE variant)", () => {
		for (const h of ["ok", "down", "unknown"] as const) {
			expect(healthLabel(h)).not.toContain("CONTROL PLANE");
		}
	});
});

describe("deriveBurnUsdPerHour", () => {
	test("derives the per-hour rate from the 24h spend", () => {
		expect(deriveBurnUsdPerHour({ windowUsd: 12, window: "24h" }, true)).toBe(0.5);
	});

	test("is null for spectators — the ops-overview spend section is absent", () => {
		expect(deriveBurnUsdPerHour(undefined, undefined)).toBeNull();
	});

	test("is null when the ops-overview database probe is unreachable", () => {
		expect(deriveBurnUsdPerHour({ windowUsd: 12, window: "24h" }, false)).toBeNull();
	});

	test("derives a figure when dbReachable is true", () => {
		expect(deriveBurnUsdPerHour({ windowUsd: 24, window: "24h" }, true)).toBe(1);
	});

	test("scales by the selected window's hour span (warren-7194)", () => {
		expect(deriveBurnUsdPerHour({ windowUsd: 336, window: "7d" }, true)).toBe(2);
	});
});

describe("burnValue", () => {
	test("renders the burn figure with a two-decimal USD rate per hour", () => {
		expect(burnValue(0.5)).toBe("$0.50 / H");
		expect(burnValue(1.5)).toBe("$1.50 / H");
	});

	test("renders the quiet placeholder when the figure is null (spectator/loading)", () => {
		expect(burnValue(null)).toBe("— / H");
	});
});

describe("runtimeValue", () => {
	test("renders the boot-resolved provider upper-cased", () => {
		expect(runtimeValue("local")).toBe("LOCAL");
		expect(runtimeValue("docker")).toBe("DOCKER");
		expect(runtimeValue("k8s")).toBe("K8S");
	});

	test("renders null while the instance facts are loading", () => {
		expect(runtimeValue(null)).toBeNull();
	});
});
