/**
 * Fail-closed guardrail config at dispatch time (warren-02aa).
 *
 * `DefaultsConfigSchema` is `.strict()`, so ONE unknown key rejects the whole
 * `.warren/config.yaml` document. The loader then yields `defaults: null` plus
 * an `errors[]` entry, and every guardrail the file carried — the admission
 * cap, the quality gate, the resource limits, the cost caps — used to vanish
 * at once with the dispatch proceeding uncapped.
 *
 * These tests drive the REAL loader (strict schema included) behind the real
 * cache, with only the filesystem stubbed, so they fail if the fail-closed
 * check is removed OR if the schema is quietly loosened to `.passthrough()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunHandle, RunSpec, RuntimeProvider } from "../../runtime/contract.ts";
import {
	createWarrenConfigCache,
	loadWarrenConfig,
	type WarrenConfigCache,
	WarrenConfigInvalidError,
} from "../../warren-config/index.ts";
import { spawnRun } from "./index.ts";
import { setupRepos } from "./test-helpers.ts";

const PROJECT_ID = "prj_xxxxxxxxxxxx";
const PROJECT_PATH = "/data/projects/x/y";

/** Records the neutral RunSpec so the test can assert the cap actually rode along. */
function makeRecordingProvider(): { provider: RuntimeProvider; specs: RunSpec[] } {
	const specs: RunSpec[] = [];
	const unused = (name: string) => () => {
		throw new Error(`${name} not exercised by spawn`);
	};
	const provider = {
		capabilities: {
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: true,
			midRunSteering: false,
			enforcedResourceLimits: true,
			workspaceArchive: false,
			workspaceGc: false,
		},
		async create(spec: RunSpec): Promise<RunHandle> {
			specs.push(spec);
			return { runId: spec.runId, sandboxId: "warren-run-pod-abc", providerRunId: "pod-uid-xyz" };
		},
		streamEvents: unused("streamEvents"),
		status: unused("status"),
		sendMessage: unused("sendMessage"),
		async cancel() {},
		workspaceInfo: unused("workspaceInfo"),
		finalize: unused("finalize"),
		terminate: unused("terminate"),
	} as unknown as RuntimeProvider;
	return { provider, specs };
}

/** A cache over the real loader, reading from an in-memory `.warren/` tree. */
function makeCache(files: Readonly<Record<string, string>>): WarrenConfigCache {
	const paths = new Set<string>([PROJECT_PATH]);
	for (const rel of Object.keys(files)) {
		paths.add(`${PROJECT_PATH}/${rel}`);
		paths.add(`${PROJECT_PATH}/.warren`);
	}
	return createWarrenConfigCache({
		load: (input) =>
			loadWarrenConfig({
				...input,
				exists: (p) => paths.has(p),
				readFile: async (p) => {
					const rel = p.slice(`${PROJECT_PATH}/`.length);
					const raw = files[rel];
					if (raw === undefined) throw new Error(`ENOENT: ${p}`);
					return raw;
				},
			}),
	});
}

async function dispatch(
	repos: Repos,
	provider: RuntimeProvider,
	warrenConfigs?: WarrenConfigCache,
): ReturnType<typeof spawnRun> {
	return spawnRun({
		repos,
		runtimeProvider: provider,
		agentName: "refactor-bot",
		projectId: PROJECT_ID,
		prompt: "do the thing",
		...(warrenConfigs !== undefined ? { warrenConfigs } : {}),
	});
}

describe("spawnRun: guardrail config fails closed (warren-02aa)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("refuses dispatch when config.yaml carries one unknown key", async () => {
		// `maxConcurrentRun` — the `s` fat-fingered off. Strict schema rejects
		// the whole document, which before this fix silently uncapped the project.
		const cache = makeCache({
			".warren/config.yaml": "admission:\n  maxConcurrentRun: 2\n",
		});
		const { provider, specs } = makeRecordingProvider();

		await expect(dispatch(repos, provider, cache)).rejects.toBeInstanceOf(WarrenConfigInvalidError);
		// No sandbox was created: the refusal precedes the runtime seam.
		expect(specs).toHaveLength(0);
	});

	test("names the offending file and the schema problem in the refusal", async () => {
		const cache = makeCache({
			".warren/config.yaml": "admission:\n  maxConcurrentRun: 2\n",
		});
		const { provider } = makeRecordingProvider();

		const err = await dispatch(repos, provider, cache).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WarrenConfigInvalidError);
		expect((err as Error).message).toContain(".warren/config.yaml");
		expect((err as Error).message).toContain("maxConcurrentRun");
	});

	test("refuses dispatch when config.yaml is not parseable YAML at all", async () => {
		const cache = makeCache({ ".warren/config.yaml": "admission:\n\tmaxConcurrentRuns: [2\n" });
		const { provider, specs } = makeRecordingProvider();

		await expect(dispatch(repos, provider, cache)).rejects.toBeInstanceOf(WarrenConfigInvalidError);
		expect(specs).toHaveLength(0);
	});

	test("valid config still enforces the admission cap on the RunSpec", async () => {
		const cache = makeCache({
			".warren/config.yaml": "admission:\n  maxConcurrentRuns: 2\nqualityGate: bun run check:all\n",
		});
		const { provider, specs } = makeRecordingProvider();

		await dispatch(repos, provider, cache);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.maxProjectConcurrency).toBe(2);
		expect(specs[0]?.env.WARREN_QUALITY_GATE).toBe("bun run check:all");
	});

	test("a project with no .warren/ directory keeps today's uncapped behavior", async () => {
		const cache = makeCache({});
		const { provider, specs } = makeRecordingProvider();

		await dispatch(repos, provider, cache);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.maxProjectConcurrency).toBeUndefined();
	});

	test("a broken triggers.yaml does NOT block dispatch (not a guardrail file)", async () => {
		// triggers.yaml constrains WHEN warren dispatches, not what a run may do,
		// so it keeps degrading gracefully; the guardrail tier stays honest.
		const cache = makeCache({
			".warren/triggers.yaml": "triggers:\n  - nope: true\n",
			".warren/config.yaml": "admission:\n  maxConcurrentRuns: 3\n",
		});
		const { provider, specs } = makeRecordingProvider();

		await dispatch(repos, provider, cache);
		expect(specs[0]?.maxProjectConcurrency).toBe(3);
	});

	test("no cache wired (CLI/tests) leaves dispatch unchanged", async () => {
		const { provider, specs } = makeRecordingProvider();
		await dispatch(repos, provider);
		expect(specs).toHaveLength(1);
	});
});
