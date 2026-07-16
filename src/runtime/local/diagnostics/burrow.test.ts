import { describe, expect, test } from "bun:test";
import { doctorBurrowCheck, resolveLocalRunBackend } from "./burrow.ts";

describe("resolveLocalRunBackend", () => {
	test("local topology resolves a provider with the preview sidecar seam", async () => {
		const backend = resolveLocalRunBackend({ WARREN_RUNTIME: "local" });
		expect(backend.runtimeProvider.capabilities.previewPorts).toBe(true);
		expect(backend.previewSidecars).toBeDefined();
		// close() tears down the lazily-built burrow client without throwing.
		await backend.close();
	});

	test("unset WARREN_RUNTIME defaults to the local backend", async () => {
		const backend = resolveLocalRunBackend({});
		expect(backend.runtimeProvider.capabilities.previewPorts).toBe(true);
		expect(backend.previewSidecars).toBeDefined();
		await backend.close();
	});

	test("k8s topology resolves a provider with no preview seam and a no-op close", async () => {
		const backend = resolveLocalRunBackend({ WARREN_RUNTIME: "k8s" });
		expect(backend.runtimeProvider.capabilities.previewPorts).toBe(false);
		expect(backend.previewSidecars).toBeUndefined();
		// No burrow client was ever constructed under k8s, so close() is a no-op.
		await backend.close();
	});
});

describe("doctorBurrowCheck", () => {
	test("returns ok when the override probe resolves", async () => {
		const check = await doctorBurrowCheck({}, async () => undefined);
		expect(check).toEqual({ name: "burrow_reachable", ok: true });
	});

	test("maps an override probe failure to a check failure", async () => {
		const check = await doctorBurrowCheck({}, async () => {
			throw new Error("ECONNREFUSED /var/run/burrow.sock");
		});
		expect(check.ok).toBe(false);
		expect(check.message).toContain("ECONNREFUSED");
	});
});
