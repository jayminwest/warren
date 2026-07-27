import { describe, expect, test } from "bun:test";
import type { PortUsage } from "../preview/port-allocator.ts";
import {
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
} from "./checks.ts";

describe("checkPreviewPortAllocator", () => {
	const usageProbe = (usage: PortUsage) => ({
		usage: async () => usage,
	});

	test("ok when under the warn threshold", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 5, total: 10, range: { start: 30000, end: 30009 } }),
		});
		expect(result.name).toBe("preview_port_allocator");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("5/10");
		expect(result.message).toContain("30000-30009");
	});

	test("fails at exactly the warn threshold (≥80%)", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 8, total: 10, range: { start: 30000, end: 30009 } }),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("8/10");
		expect(result.message).toContain("80%");
		expect(result.hint).toContain("WARREN_PREVIEW_PORT_RANGE");
	});

	test("fails when saturation is above threshold", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 1001, total: 1001, range: { start: 30000, end: 31000 } }),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1001/1001");
	});

	test("respects an override warnRatio", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 5, total: 10, range: { start: 30000, end: 30009 } }),
			warnRatio: 0.5,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("50%");
	});

	test("ok message survives a zero in-use snapshot", async () => {
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 0, total: 1001, range: { start: 30000, end: 31000 } }),
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("0/1001");
	});

	test("treats a zero-total range as fully saturated (defensive)", async () => {
		// total=0 should never occur in production (constructor rejects an
		// inverted range), but the check shouldn't divide by zero — clamp
		// to ratio=1 so the operator gets a clear failure instead of NaN.
		const result = await checkPreviewPortAllocator({
			probe: usageProbe({ inUse: 0, total: 0, range: { start: 30000, end: 30000 } }),
		});
		expect(result.ok).toBe(false);
	});

	test("fails with a reason code, not the driver text, when usage() throws (warren-51de)", async () => {
		const logged: object[] = [];
		const result = await checkPreviewPortAllocator({
			probe: {
				usage: async () => {
					throw new Error("connection is closed");
				},
			},
			log: { warn: (obj) => logged.push(obj) },
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("probe failed (reason=unreachable)");
		expect(result.hint).toContain("migration 0009");
		expect(logged[0]).toMatchObject({
			check: "preview_port_allocator",
			err_message: "Error: connection is closed",
		});
	});
});

describe("checkPreviewMaxLive", () => {
	test("ok under the warn threshold", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 10 },
			maxLive: 20,
		});
		expect(result.name).toBe("preview_max_live");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("10/20");
	});

	test("fails at exactly 80% saturation", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 16 },
			maxLive: 20,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("16/20");
		expect(result.message).toContain("80%");
		expect(result.hint).toContain("WARREN_PREVIEW_MAX_LIVE");
	});

	test("respects an override warnRatio", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 5 },
			maxLive: 10,
			warnRatio: 0.5,
		});
		expect(result.ok).toBe(false);
	});

	test("clamps a zero-cap to fully saturated", async () => {
		const result = await checkPreviewMaxLive({
			probe: { count: async () => 0 },
			maxLive: 0,
		});
		expect(result.ok).toBe(false);
	});

	test("fails with a reason code, not the driver text, when count() throws (warren-51de)", async () => {
		const result = await checkPreviewMaxLive({
			probe: {
				count: async () => {
					throw new Error('relation "run_previews" does not exist');
				},
			},
			maxLive: 20,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("probe failed (reason=migration_pending)");
		expect(result.message).not.toContain("run_previews");
		expect(result.hint).toContain("migration 0009");
	});
});

describe("checkPreviewAuthStrength", () => {
	const STRONG_TOKEN = "1f3a2b9c0d4e5f6789abcdef0123456789abcdef0123456789abcdef01234567";

	test("ok and informational when WARREN_PREVIEW_HOST is unset", () => {
		const result = checkPreviewAuthStrength({ env: {} });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("WARREN_PREVIEW_HOST unset");
	});

	test("ok when host is set + token is strong, without echoing either value", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: STRONG_TOKEN },
		});
		expect(result.ok).toBe(true);
		expect(result.message).toBe("WARREN_PREVIEW_HOST and WARREN_API_TOKEN configured");
		expect(result.message).not.toContain("preview.example.com");
	});

	test("fails when host is set + token is empty", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: "" },
		});
		expect(result.ok).toBe(false);
		expect(result.hint).toContain("openssl rand -hex 32");
	});

	test("fails when token matches a documented placeholder", () => {
		for (const placeholder of ["changeme", "Placeholder", "warren-token", "your-token-here"]) {
			const result = checkPreviewAuthStrength({
				env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: placeholder },
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain("placeholder");
		}
	});

	test("fails when token is shorter than the minimum strength", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: "shorty" },
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("shorter than the preview surface minimum");
	});

	test("never discloses the token's length or the minimum (warren-51de)", () => {
		// A length is a real search-space reduction, and `/readyz` renders
		// `message` verbatim — so no check message may carry a digit run.
		for (const token of ["", "shorty", "changeme", STRONG_TOKEN]) {
			const result = checkPreviewAuthStrength({
				env: { WARREN_PREVIEW_HOST: "preview.example.com", WARREN_API_TOKEN: token },
			});
			expect(result.message ?? "").not.toMatch(/[0-9]{2,}/);
		}
	});

	test("blank WARREN_PREVIEW_HOST is treated as unset", () => {
		const result = checkPreviewAuthStrength({
			env: { WARREN_PREVIEW_HOST: "   ", WARREN_API_TOKEN: "shorty" },
		});
		expect(result.ok).toBe(true);
	});
});
