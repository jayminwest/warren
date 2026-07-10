import { describe, expect, test } from "bun:test";
import type { BurrowClientPool } from "../burrow-client/index.ts";
import { RuntimeNotImplementedError, UnknownRuntimeError } from "./errors.ts";
import { LocalProvider } from "./local/provider.ts";
import {
	DEFAULT_RUNTIME_KIND,
	type RuntimeProviderDeps,
	resolveRuntimeKind,
	resolveRuntimeProvider,
} from "./registry.ts";

/**
 * Hermetic deps: the pool factory throws if invoked. No stub method calls it, so
 * resolution + capability reads never touch burrow — no socket, no DB.
 */
const deps: RuntimeProviderDeps = {
	burrowClientPool: (): BurrowClientPool => {
		throw new Error("burrowClientPool factory must not be called by the LocalProvider shell");
	},
};

describe("resolveRuntimeKind", () => {
	test("defaults to local when WARREN_RUNTIME is unset", () => {
		expect(resolveRuntimeKind({})).toBe("local");
		expect(DEFAULT_RUNTIME_KIND).toBe("local");
	});

	test("treats a blank / whitespace value as unset (default local)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "" })).toBe("local");
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "   " })).toBe("local");
	});

	test("accepts the explicit local selector", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "local" })).toBe("local");
	});

	test("accepts the k8s selector (kind parses; provider build is what defers)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "k8s" })).toBe("k8s");
	});

	test("fails loudly on an unknown value rather than falling back", () => {
		expect(() => resolveRuntimeKind({ WARREN_RUNTIME: "docker" })).toThrow(UnknownRuntimeError);
	});
});

describe("resolveRuntimeProvider", () => {
	test("resolves LocalProvider by default", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("resolves LocalProvider for explicit WARREN_RUNTIME=local", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "local" });
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("advertises the full burrow capability set", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
		});
	});

	test("k8s selector throws a clear not-implemented error (phase 3)", () => {
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "k8s" })).toThrow(
			RuntimeNotImplementedError,
		);
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "k8s" })).toThrow(/phase 3/);
	});

	test("garbage selector throws UnknownRuntimeError", () => {
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(
			UnknownRuntimeError,
		);
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(/nomad/);
	});
});
