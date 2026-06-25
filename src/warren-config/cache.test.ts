import { describe, expect, test } from "bun:test";
import { createWarrenConfigCache, type WarrenConfigLoader } from "./cache.ts";
import { WarrenConfigUnavailableError } from "./errors.ts";
import type { LoadedWarrenConfig } from "./load.ts";

const PROJECT_ID = "prj_abc";
const PROJECT_PATH = "/data/projects/owner/repo";

function envelope(overrides: Partial<LoadedWarrenConfig> = {}): LoadedWarrenConfig {
	return {
		triggers: overrides.triggers ?? null,
		defaults: overrides.defaults ?? null,
		prTemplate: overrides.prTemplate ?? null,
		sourceFile: overrides.sourceFile ?? null,
		errors: overrides.errors ?? [],
		warnings: overrides.warnings ?? [],
	};
}

describe("createWarrenConfigCache", () => {
	test("caches the parsed envelope across calls (single parse)", async () => {
		let loads = 0;
		const load: WarrenConfigLoader = async () => {
			loads += 1;
			return envelope({ defaults: { defaultBranch: "main" } });
		};
		const cache = createWarrenConfigCache({ load });

		const a = await cache.get(PROJECT_ID, PROJECT_PATH);
		const b = await cache.get(PROJECT_ID, PROJECT_PATH);

		expect(loads).toBe(1);
		expect(a).toBe(b);
		expect(cache.size()).toBe(1);
	});

	test("concurrent get() calls share the in-flight load (single-flight)", async () => {
		let loads = 0;
		let resolveFirst: (value: LoadedWarrenConfig) => void = () => {};
		const load: WarrenConfigLoader = () => {
			loads += 1;
			return new Promise<LoadedWarrenConfig>((resolve) => {
				resolveFirst = resolve;
			});
		};
		const cache = createWarrenConfigCache({ load });

		const p1 = cache.get(PROJECT_ID, PROJECT_PATH);
		const p2 = cache.get(PROJECT_ID, PROJECT_PATH);
		expect(loads).toBe(1);

		resolveFirst(envelope());
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe(r2);
	});

	test("invalidate() drops the resolved entry so the next get re-parses", async () => {
		const values: LoadedWarrenConfig[] = [
			envelope({ defaults: { defaultBranch: "main" } }),
			envelope({ defaults: { defaultBranch: "trunk" } }),
		];
		let i = 0;
		const load: WarrenConfigLoader = async () => {
			const next = values[i++];
			if (!next) throw new Error("loader called too many times");
			return next;
		};
		const cache = createWarrenConfigCache({ load });

		const first = await cache.get(PROJECT_ID, PROJECT_PATH);
		expect(first.defaults?.defaultBranch).toBe("main");

		cache.invalidate(PROJECT_ID);
		expect(cache.size()).toBe(0);

		const second = await cache.get(PROJECT_ID, PROJECT_PATH);
		expect(second.defaults?.defaultBranch).toBe("trunk");
	});

	test("invalidate() mid-flight prevents the in-flight load from caching its result", async () => {
		// Per pl-5d74 risk #4 — refreshProject invalidates BEFORE
		// recordRefresh so a reader that started a parse against the
		// pre-fetch tree never commits that stale envelope to the cache.
		const values: LoadedWarrenConfig[] = [
			envelope({ defaults: { defaultBranch: "stale" } }),
			envelope({ defaults: { defaultBranch: "fresh" } }),
		];
		let i = 0;
		let resolveFirst: (value: LoadedWarrenConfig) => void = () => {};
		const load: WarrenConfigLoader = () => {
			const index = i++;
			return new Promise<LoadedWarrenConfig>((resolve) => {
				if (index === 0) {
					resolveFirst = () => resolve(values[0] as LoadedWarrenConfig);
				} else {
					resolve(values[index] as LoadedWarrenConfig);
				}
			});
		};
		const cache = createWarrenConfigCache({ load });

		const inflight = cache.get(PROJECT_ID, PROJECT_PATH);
		cache.invalidate(PROJECT_ID);
		resolveFirst(values[0] as LoadedWarrenConfig);
		// The in-flight promise still resolves to the stale value, but
		// the cache must NOT have committed it.
		const observed = await inflight;
		expect(observed.defaults?.defaultBranch).toBe("stale");
		expect(cache.size()).toBe(0);

		const next = await cache.get(PROJECT_ID, PROJECT_PATH);
		expect(next.defaults?.defaultBranch).toBe("fresh");
	});

	test("loader rejection drops the in-flight entry so retries hit the loader again", async () => {
		let attempts = 0;
		const load: WarrenConfigLoader = async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new WarrenConfigUnavailableError("clone missing");
			}
			return envelope();
		};
		const cache = createWarrenConfigCache({ load });

		await expect(cache.get(PROJECT_ID, PROJECT_PATH)).rejects.toBeInstanceOf(
			WarrenConfigUnavailableError,
		);
		expect(cache.size()).toBe(0);

		const second = await cache.get(PROJECT_ID, PROJECT_PATH);
		expect(second).toBeDefined();
		expect(attempts).toBe(2);
	});

	test("clear() drops every entry", async () => {
		let loads = 0;
		const load: WarrenConfigLoader = async () => {
			loads += 1;
			return envelope();
		};
		const cache = createWarrenConfigCache({ load });

		await cache.get("prj_a", "/p/a");
		await cache.get("prj_b", "/p/b");
		expect(cache.size()).toBe(2);

		cache.clear();
		expect(cache.size()).toBe(0);
		await cache.get("prj_a", "/p/a");
		expect(loads).toBe(3);
	});

	test("different project ids parse independently", async () => {
		const seen: string[] = [];
		const load: WarrenConfigLoader = async (input) => {
			seen.push(input.projectPath);
			return envelope();
		};
		const cache = createWarrenConfigCache({ load });

		await cache.get("prj_a", "/p/a");
		await cache.get("prj_b", "/p/b");
		await cache.get("prj_a", "/p/a");

		expect(seen).toEqual(["/p/a", "/p/b"]);
	});
});
