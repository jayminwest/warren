/**
 * Shared harness for the provider-retry suites.
 *
 * The suite outgrew one file once the attempt bound arrived (warren-ac61):
 * `provider-retry.test.ts` sat one line under the 500-line ceiling on main,
 * so the bound cases moved to `provider-retry.bound.test.ts` and the fixture
 * they both drive lives here rather than being written twice.
 *
 * Not a suite: it registers nothing. A caller wires `afterEach(closeOpenDb)`.
 */

/**
 * The post_reap subscriber of the run-level provider-error retry
 * (warren-339d). Drives the handler directly, the way the seed-close
 * subscriber's tests do, against an in-memory DB with a stubbed spawn
 * seam. It asserts that a transient `provider_error` is redispatched with
 * lineage on both runs' streams, that every fail-closed gate skips
 * (durable message, plan-run child, non-failed outcome), and that the
 * attempt bound stops the lineage and says so.
 *
 * The pure classifier lives in `provider-retry.classify.test.ts`.
 */

import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	type LifecycleEnvelope,
	type PostReapPayload,
	WARREN_EXT_PROTOCOL,
} from "../lifecycle-bus.ts";
import type { spawnRun } from "../spawn/index.ts";
import type { BridgeRegistry } from "../stream/types.ts";
import {
	createProviderRetryLifecycleExtension,
	PROVIDER_RETRY_EVENTS,
	type ProviderRetryLifecycleExtensionInput,
} from "./provider-retry.ts";

// ---- Extension harness ----------------------------------------------------

let openDb: WarrenDb | null = null;

export { WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
export {
	createProviderRetryLifecycleExtension,
	type ProviderRetryLifecycleExtensionInput,
} from "./provider-retry.ts";

/** The in-memory DB the current fixture opened, for a suite that closes it early. */
export function currentDb(): WarrenDb | null {
	return openDb;
}

/** Register with `afterEach` in each suite that uses {@link setup}. */
export function closeOpenDb(): void {
	openDb?.close();
	openDb = null;
}

export type Repos = ReturnType<typeof createRepos>;

export interface Fixture {
	repos: Repos;
	runId: string;
	projectId: string;
}

export async function setup(
	opts: {
		trigger?: string;
		seedId?: string | null;
		providerMessage?: string;
		httpStatus?: number | null;
		upstreamBody?: string | null;
		/** Folded onto the failed run the way a real dispatch freezes it. */
		frontmatter?: Record<string, unknown>;
		/** Provider retries already dispatched in the lineage before this run. */
		priorRetries?: number;
		/** Stamp the failed run itself as a dispatched provider retry (default: `priorRetries > 0`). */
		stampFailedRun?: boolean;
	} = {},
): Promise<Fixture> {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const ancestorId = await buildRetryLineage(
		repos,
		project.id,
		opts.trigger ?? "manual",
		opts.priorRetries ?? 0,
	);
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "work the seed",
		renderedAgentJson: opts.frontmatter !== undefined ? { frontmatter: opts.frontmatter } : {},
		trigger: opts.trigger ?? "manual",
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
		...(opts.seedId !== null ? { seedId: opts.seedId ?? "warren-339d" } : {}),
		...(ancestorId !== null ? retryLinks(ancestorId) : {}),
	});
	await repos.runs.markRunning(run.id);
	await repos.runs.finalize(run.id, "failed", new Date(), "provider_error");
	await repos.events.append({
		runId: run.id,
		sandboxEventSeq: 1,
		ts: new Date().toISOString(),
		kind: "reap.provider_error",
		stream: "system",
		payload: {
			message: opts.providerMessage ?? "Network connection lost.",
			httpStatus: opts.httpStatus ?? null,
			upstreamBody: opts.upstreamBody ?? null,
		},
	});
	if (ancestorId !== null && (opts.stampFailedRun ?? true)) {
		await stampProviderRetry(repos, run.id, ancestorId);
	}
	return { repos, runId: run.id, projectId: project.id };
}

/** The row links `dispatchProviderRetry` writes onto the retry it spawns. */
function retryLinks(ancestorId: string) {
	return { parentRunId: ancestorId, cloneKind: "replicate" as const, retryOf: ancestorId };
}

/**
 * The lineage behind the failed run: a root dispatched by hand, then one
 * already-dispatched provider retry for every attempt after the first,
 * linked and stamped the way `dispatchProviderRetry` writes them. Returns
 * the id the failed run links back to, or `null` when it starts a lineage.
 */
async function buildRetryLineage(
	repos: Repos,
	projectId: string,
	trigger: string,
	priorRetries: number,
): Promise<string | null> {
	let ancestorId: string | null = null;
	for (let i = 0; i < priorRetries; i++) {
		const ancestor = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "work the seed",
			renderedAgentJson: {},
			trigger,
			...(ancestorId !== null ? retryLinks(ancestorId) : {}),
		});
		if (ancestorId !== null) await stampProviderRetry(repos, ancestor.id, ancestorId);
		ancestorId = ancestor.id;
	}
	return ancestorId;
}

/** The lineage stamp `dispatchProviderRetry` appends to a retry's stream. */
async function stampProviderRetry(repos: Repos, runId: string, fromRunId: string): Promise<void> {
	const maxSeq = (await repos.events.maxSeqForRun(runId)) ?? 0;
	await repos.events.append({
		runId,
		sandboxEventSeq: maxSeq + 1,
		ts: new Date().toISOString(),
		kind: PROVIDER_RETRY_EVENTS.spawnRetry,
		stream: "system",
		payload: { retriedFromRunId: fromRunId, providerError: "Network connection lost." },
	});
}

export function recordingBridges(): { bridges: BridgeRegistry; started: string[] } {
	const started: string[] = [];
	return {
		started,
		bridges: {
			start: (runId) => void started.push(runId),
			stopAll: async () => {},
			size: () => started.length,
		},
	};
}

export function recordingLogger() {
	const lines: Array<{ obj: object; msg?: string }> = [];
	return {
		lines,
		logger: {
			info: (obj: object, msg?: string) => void lines.push({ obj, msg }),
			warn: (obj: object, msg?: string) => void lines.push({ obj, msg }),
			error: (obj: object, msg?: string) => void lines.push({ obj, msg }),
		},
	};
}

export type SpawnCall = Parameters<typeof spawnRun>[0];

export interface SpawnStub {
	spawnRunFn: typeof spawnRun;
	calls: SpawnCall[];
	newRunId: string;
}

/** A spawnRun stub that persists a real successor row and records its input. */
export function stubSpawn(repos: Repos, opts: { throw?: Error } = {}): SpawnStub {
	const calls: SpawnCall[] = [];
	let newRunId = "";
	const spawnRunFn = (async (input: SpawnCall) => {
		calls.push(input);
		if (opts.throw !== undefined) throw opts.throw;
		const row = await repos.runs.create({
			agentName: input.agentName,
			projectId: input.projectId,
			prompt: input.prompt,
			renderedAgentJson: {},
			trigger: input.trigger ?? "manual",
			...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
			...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
			...(input.cloneKind !== undefined ? { cloneKind: input.cloneKind } : {}),
		});
		newRunId = row.id;
		return {
			run: row,
			sandbox: { id: "bur_new", workspacePath: "" },
			sandboxRun: { id: "run_new" },
			agent: { name: input.agentName },
		};
	}) as unknown as typeof spawnRun;
	return {
		spawnRunFn,
		calls,
		get newRunId() {
			return newRunId;
		},
	} as SpawnStub;
}

export function envelope(runId: string, projectId: string): LifecycleEnvelope<"post_reap"> {
	const payload: PostReapPayload = {
		runId,
		projectId,
		outcome: "failed",
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
	};
	return {
		protocol: WARREN_EXT_PROTOCOL,
		hook: "post_reap",
		runId,
		at: "2026-08-07T00:00:00.000Z",
		payload,
	};
}

export async function fire(
	fixture: Fixture,
	overrides: Partial<ProviderRetryLifecycleExtensionInput> = {},
): Promise<{ spawn: SpawnStub; started: string[] }> {
	const spawn = stubSpawn(fixture.repos);
	const { bridges, started } = recordingBridges();
	const { logger } = recordingLogger();
	const ext = createProviderRetryLifecycleExtension({
		repos: fixture.repos,
		runtimeProvider: {} as ProviderRetryLifecycleExtensionInput["runtimeProvider"],
		bridges,
		projectsConfig: {} as ProviderRetryLifecycleExtensionInput["projectsConfig"],
		projectSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		logger,
		spawnRunFn: spawn.spawnRunFn,
		...overrides,
	});
	await ext.hooks.post_reap?.(envelope(fixture.runId, fixture.projectId));
	return { spawn, started };
}
