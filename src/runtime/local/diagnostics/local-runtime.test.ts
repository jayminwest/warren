import { describe, expect, test } from "bun:test";
import { doctorLocalRuntimeCheck, resolveLocalRunBackend } from "./local-runtime.ts";

describe("resolveLocalRunBackend", () => {
	test("local topology resolves a provider with the preview sidecar seam", async () => {
		const backend = resolveLocalRunBackend({ WARREN_RUNTIME: "local" });
		expect(backend.runtimeProvider.capabilities.previewPorts).toBe(true);
		expect(backend.previewSidecars).toBeDefined();
		// close() tears down the sidecar registry without throwing.
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
		// No sidecar registry work happens under k8s, so close() is a no-op.
		await backend.close();
	});
});

describe("doctorLocalRuntimeCheck", () => {
	test("returns ok when the override probe resolves", async () => {
		const check = await doctorLocalRuntimeCheck({}, async () => undefined);
		expect(check).toEqual({ name: "local_runtime", ok: true });
	});

	test("maps an override probe failure to a check failure", async () => {
		const check = await doctorLocalRuntimeCheck({}, async () => {
			throw new Error("sandbox bringup failed");
		});
		expect(check.ok).toBe(false);
		expect(check.message).toContain("sandbox bringup failed");
	});

	test("reports the in-process engine when no retired burrow env vars are set", async () => {
		const check = await doctorLocalRuntimeCheck({});
		expect(check.ok).toBe(true);
		expect(check.message).toContain("in-process sandbox engine");
		expect(check.message).not.toContain("dead config");
	});

	test("flags retired burrow env vars as dead config without failing", async () => {
		const check = await doctorLocalRuntimeCheck({
			WARREN_BURROW_SOCKET: "/var/run/burrow.sock",
			BURROW_API_TOKEN: "secret",
		});
		expect(check.ok).toBe(true);
		expect(check.message).toContain("WARREN_BURROW_SOCKET");
		expect(check.message).toContain("BURROW_API_TOKEN");
		expect(check.hint).toContain("nothing reads them");
	});

	test("treats empty-string retired env vars as unset", async () => {
		const check = await doctorLocalRuntimeCheck({ WARREN_BURROW_SOCKET: "" });
		expect(check.ok).toBe(true);
		expect(check.message).not.toContain("dead config");
	});
});
