import { describe, expect, test } from "bun:test";
import { ResourcesConfigSchema } from "./resources-config.ts";
import { DefaultsConfigSchema } from "./schema.ts";

/**
 * K8s per-run pod resource + network defaults (warren-ac7a / pl-829f step 14).
 * The block lives in `resources-config.ts` and folds into `DefaultsConfigSchema`;
 * both surfaces are exercised here.
 */
describe("DefaultsConfigSchema resources block", () => {
	test("leaves resources undefined when the block is omitted (builder uses DEFAULT_K8S_*)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.resources).toBeUndefined();
	});

	test("accepts a full requests/limits/network block", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			resources: {
				requests: { memoryMiB: 2048, cpuMillicores: 1000 },
				limits: { memoryMiB: 4096, cpuMillicores: 4000 },
				network: "restricted",
			},
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.resources?.limits?.memoryMiB).toBe(4096);
			expect(parsed.data.resources?.network).toBe("restricted");
		}
	});

	test("accepts a partial block — a project may pin just one knob", () => {
		const parsed = DefaultsConfigSchema.safeParse({ resources: { limits: { memoryMiB: 8192 } } });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.resources?.limits?.memoryMiB).toBe(8192);
			expect(parsed.data.resources?.limits?.cpuMillicores).toBeUndefined();
			expect(parsed.data.resources?.requests).toBeUndefined();
		}
	});
});

describe("ResourcesConfigSchema bounds + strictness", () => {
	test("enforces the memory + cpu bounds", () => {
		expect(ResourcesConfigSchema.safeParse({ limits: { memoryMiB: 32 } }).success).toBe(false); // below 64 MiB floor
		expect(ResourcesConfigSchema.safeParse({ limits: { memoryMiB: 200_000 } }).success).toBe(false); // above 128 GiB ceiling
		expect(ResourcesConfigSchema.safeParse({ requests: { cpuMillicores: 5 } }).success).toBe(false); // below 10m floor
		expect(ResourcesConfigSchema.safeParse({ requests: { cpuMillicores: 100_000 } }).success).toBe(
			false,
		); // above 64-core ceiling
	});

	test("enforces the ephemeral-storage bounds (warren-653f)", () => {
		expect(ResourcesConfigSchema.safeParse({ limits: { ephemeralStorageMiB: 32 } }).success).toBe(
			false,
		); // below 64 MiB floor
		expect(
			ResourcesConfigSchema.safeParse({ limits: { ephemeralStorageMiB: 2_000_000 } }).success,
		).toBe(false); // above 1 TiB ceiling
		expect(
			ResourcesConfigSchema.safeParse({ limits: { ephemeralStorageMiB: 1024.5 } }).success,
		).toBe(false); // non-integer
		expect(
			ResourcesConfigSchema.safeParse({
				requests: { ephemeralStorageMiB: 4096 },
				limits: { ephemeralStorageMiB: 20_480 },
			}).success,
		).toBe(true);
	});

	test("rejects a non-integer memory value and an unknown network policy", () => {
		expect(ResourcesConfigSchema.safeParse({ limits: { memoryMiB: 1024.5 } }).success).toBe(false);
		expect(ResourcesConfigSchema.safeParse({ network: "vpc" }).success).toBe(false);
	});

	test("rejects unknown fields inside the resources block (strict)", () => {
		expect(ResourcesConfigSchema.safeParse({ gpu: 1 }).success).toBe(false);
		expect(ResourcesConfigSchema.safeParse({ limits: { swapMiB: 1024 } }).success).toBe(false);
	});

	test("accepts the fully-specified shape", () => {
		const parsed = ResourcesConfigSchema.safeParse({
			requests: { memoryMiB: 512, cpuMillicores: 250 },
			limits: { memoryMiB: 8192, cpuMillicores: 8000 },
			network: "none",
		});
		expect(parsed.success).toBe(true);
	});
});
