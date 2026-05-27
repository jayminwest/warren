import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyWarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { isPostgresTestEnabled, withDb } from "../../db/testing.ts";
import { RunEventBroker } from "../../runs/events.ts";
import { createWarrenConfigCache, type LoadedWarrenConfig } from "../../warren-config/index.ts";
import { createRunPreviewsRepo } from "./repo.ts";
import { BASE_CONFIG, fakeSidecars } from "./test-helpers.ts";
import { runPreviewEvictionTick } from "./tick.ts";
import type { EvictionReason, RunPreviewsRepo } from "./types.ts";

function tickSuite(dialect: "sqlite" | "postgres"): void {
	describe(`runPreviewEvictionTick (${dialect})`, () => {
		let db: AnyWarrenDb;
		let close: () => Promise<void>;
		let repos: Repos;
		let previews: RunPreviewsRepo;
		let projectId: string;

		beforeEach(async () => {
			const handle = await withDb({ dialect });
			db = handle.db;
			close = handle.close;
			repos = createRepos(db);
			await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
			const project = await repos.projects.create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			projectId = project.id;
			previews = createRunPreviewsRepo(db);
		});

		afterEach(async () => {
			await close();
		});

		async function spawnLivePreview(opts: {
			port: number;
			startedAt: string;
			lastHitAt?: string;
			burrowId?: string;
			state?: "starting" | "live";
		}): Promise<string> {
			const run = await repos.runs.create({
				agentName: "agent",
				projectId,
				prompt: "p",
				renderedAgentJson: {},
				trigger: "manual",
				burrowId: opts.burrowId ?? `bur_${opts.port}`,
			});
			await repos.runs.attachPreview(run.id, {
				previewState: opts.state ?? "live",
				previewPort: opts.port,
				previewStartedAt: opts.startedAt,
				...(opts.lastHitAt !== undefined ? { previewLastHitAt: opts.lastHitAt } : {}),
			});
			return run.id;
		}

		function fakeConfigs(): {
			cache: ReturnType<typeof createWarrenConfigCache>;
			setOverride(idleTtl?: string, maxLifetime?: string): void;
		} {
			let idleTtl: string | undefined;
			let maxLifetime: string | undefined;
			const load = async (): Promise<LoadedWarrenConfig> => ({
				triggers: null,
				defaults:
					idleTtl !== undefined || maxLifetime !== undefined
						? {
								preview: {
									type: "server",
									command: "bun run dev",
									port: 3000,
									...(idleTtl !== undefined ? { idle_ttl: idleTtl } : {}),
									...(maxLifetime !== undefined ? { max_lifetime: maxLifetime } : {}),
								},
							}
						: null,
				prTemplate: null,
				errors: [],
				warnings: [],
			});
			const cache = createWarrenConfigCache({ load });
			return {
				cache,
				setOverride(t, m) {
					idleTtl = t;
					maxLifetime = m;
				},
			};
		}

		test("evicts a live preview past the global idle TTL", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const lastHit = new Date(now.getTime() - 31 * 60_000).toISOString();
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 90 * 60_000).toISOString(),
				lastHitAt: lastHit,
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toEqual([{ runId, reason: "idle_ttl" }]);
			const reread = await repos.runs.require(runId);
			expect(reread.previewState).toBe("torn-down");
			expect(reread.previewPort).toBeNull();
			expect(sidecars.calls).toHaveLength(1);
		});

		test("evicts past max_lifetime even when last_hit is recent", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 9 * 3_600_000).toISOString(),
				lastHitAt: new Date(now.getTime() - 60_000).toISOString(),
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toEqual([{ runId, reason: "max_lifetime" }]);
		});

		test("idle clock falls back to started_at when last_hit_at is null", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toEqual([{ runId, reason: "idle_ttl" }]);
		});

		test("per-project idle_ttl override beats the global value", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
				lastHitAt: new Date(now.getTime() - 90_000).toISOString(),
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			configs.setOverride("1m");

			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toEqual([{ runId, reason: "idle_ttl" }]);
		});

		test("LRU evicts the longest-idle preview when count exceeds max_live", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const recentRunId = await spawnLivePreview({
				port: 40001,
				startedAt: new Date(now.getTime() - 60_000).toISOString(),
				lastHitAt: new Date(now.getTime() - 30_000).toISOString(),
			});
			const idleRunId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lastHitAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: { ...BASE_CONFIG, maxLive: 1 },
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toEqual([{ runId: idleRunId, reason: "lru" }]);
			const idle = await repos.runs.require(idleRunId);
			expect(idle.previewState).toBe("torn-down");
			const recent = await repos.runs.require(recentRunId);
			expect(recent.previewState).toBe("live");
		});

		test("keeps a fresh preview within all signals", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 60_000).toISOString(),
				lastHitAt: new Date(now.getTime() - 10_000).toISOString(),
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.evicted).toHaveLength(0);
			expect(sidecars.calls).toHaveLength(0);
			const reread = await repos.runs.require(runId);
			expect(reread.previewState).toBe("live");
		});

		test("emits preview_evicted event with reason + previous state + port", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 9 * 3_600_000).toISOString(),
				state: "live",
			});

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const broker = new RunEventBroker();
			await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				broker,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			const events = await repos.events.listByRun(runId);
			const evict = events.find((e) => e.kind === "preview_evicted");
			expect(evict).toBeDefined();
			expect(evict?.stream).toBe("system");
			expect((evict?.payloadJson as { reason?: EvictionReason }).reason).toBe("max_lifetime");
			expect((evict?.payloadJson as { port?: number | null }).port).toBe(40000);
			expect((evict?.payloadJson as { previousState?: string }).previousState).toBe("live");
		});

		test("re-entrant with manual teardown: torn-down rows are skipped", async () => {
			const now = new Date("2026-05-14T18:00:00.000Z");
			const runId = await spawnLivePreview({
				port: 40000,
				startedAt: new Date(now.getTime() - 9 * 3_600_000).toISOString(),
			});
			await repos.runs.attachPreview(runId, { previewState: "torn-down", previewPort: null });

			const sidecars = fakeSidecars();
			const configs = fakeConfigs();
			const result = await runPreviewEvictionTick({
				db,
				repos,
				burrowClientPool: undefined as never,
				warrenConfigs: configs.cache,
				config: BASE_CONFIG,
				now: () => now,
				resolveSidecar: sidecars.resolver,
				previews,
			});

			expect(result.scanned).toBe(0);
			expect(result.evicted).toHaveLength(0);
		});

		test("countActivePreviews returns the starting+live count", async () => {
			await spawnLivePreview({ port: 40001, startedAt: new Date().toISOString() });
			await spawnLivePreview({
				port: 40002,
				startedAt: new Date().toISOString(),
				state: "starting",
			});
			const torn = await spawnLivePreview({ port: 40003, startedAt: new Date().toISOString() });
			await repos.runs.attachPreview(torn, { previewState: "torn-down", previewPort: null });

			expect(await previews.countActivePreviews()).toBe(2);
		});

		test("claimTeardown returns torn-down for a live preview and clears the port", async () => {
			const runId = await spawnLivePreview({
				port: 40500,
				startedAt: new Date().toISOString(),
			});

			const claim = await previews.claimTeardown({ runId });
			expect(claim.status).toBe("torn-down");
			expect(claim.previousState).toBe("live");
			expect(claim.port).toBe(40500);

			const reread = await repos.runs.require(runId);
			expect(reread.previewState).toBe("torn-down");
			expect(reread.previewPort).toBeNull();
		});

		test("claimTeardown returns already-torn-down on a second call", async () => {
			const runId = await spawnLivePreview({
				port: 40500,
				startedAt: new Date().toISOString(),
			});
			await previews.claimTeardown({ runId });
			const second = await previews.claimTeardown({ runId });
			expect(second.status).toBe("already-torn-down");
		});

		test("claimTeardown reports never-launched when state is null", async () => {
			const run = await repos.runs.create({
				agentName: "agent",
				projectId,
				prompt: "p",
				renderedAgentJson: {},
				trigger: "manual",
			});
			const claim = await previews.claimTeardown({ runId: run.id });
			expect(claim.status).toBe("never-launched");
			expect(claim.previousState).toBeNull();
		});
	});
}

tickSuite("sqlite");
if (isPostgresTestEnabled()) {
	tickSuite("postgres");
}
