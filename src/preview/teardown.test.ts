import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { NotFoundError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/events.ts";
import {
	createRunPreviewsRepo,
	type SidecarClient,
	type SidecarResolver,
} from "./eviction/index.ts";
import { PREVIEW_TORN_DOWN_EVENT_KIND, teardownPreview } from "./teardown.ts";

interface FakeSidecars {
	resolver: SidecarResolver;
	listingsBySidecar: Map<string, string[]>;
	deletions: Array<{ burrowId: string; sidecarId: string }>;
	listsCalled: string[];
	listFailures: Set<string>;
	deleteFailures: Set<string>;
}

function fakeSidecars(): FakeSidecars {
	const listingsBySidecar = new Map<string, string[]>();
	const deletions: Array<{ burrowId: string; sidecarId: string }> = [];
	const listsCalled: string[] = [];
	const listFailures = new Set<string>();
	const deleteFailures = new Set<string>();
	const resolver: SidecarResolver = async (burrowId): Promise<SidecarClient | null> => {
		// Auto-seed one sidecar so list() returns something to delete.
		if (!listingsBySidecar.has(burrowId)) {
			listingsBySidecar.set(burrowId, [`sc_${burrowId}`]);
		}
		return {
			list: async (id) => {
				listsCalled.push(id);
				if (listFailures.has(id)) {
					throw new Error(`list failed for ${id}`);
				}
				return (listingsBySidecar.get(id) ?? []).map((sid) => ({ id: sid }));
			},
			delete: async (id, scid) => {
				if (deleteFailures.has(scid)) {
					throw new Error(`delete failed for ${scid}`);
				}
				deletions.push({ burrowId: id, sidecarId: scid });
				const cur = listingsBySidecar.get(id) ?? [];
				listingsBySidecar.set(
					id,
					cur.filter((s) => s !== scid),
				);
			},
		};
	};
	return { resolver, listingsBySidecar, deletions, listsCalled, listFailures, deleteFailures };
}

function emptyPool(repos: Repos): BurrowClientPool {
	// Use a real-but-unused pool — teardownPreview only invokes it when the
	// caller didn't inject a sidecar resolver; every test below overrides
	// the resolver, so the pool is never reached.
	const pool = new BurrowClientPool({ repos });
	pool.register(
		"local",
		new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: (async () => new Response("{}")) as unknown as typeof fetch,
		}),
	);
	return pool;
}

describe("teardownPreview", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	});

	afterEach(async () => {
		await db.close();
	});

	async function spawnPreview(opts: {
		state?: "starting" | "live" | "failed" | "torn-down" | null;
		port?: number | null;
		burrowId?: string;
	}): Promise<string> {
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: opts.burrowId ?? "bur_test",
		});
		if (opts.state !== undefined) {
			await repos.runs.attachPreview(run.id, {
				previewState: opts.state,
				...(opts.port !== undefined ? { previewPort: opts.port } : {}),
				previewStartedAt: "2026-05-14T18:00:00.000Z",
			});
		}
		return run.id;
	}

	test("tears down a live preview, releases the port, emits an event, stops the sidecar", async () => {
		const runId = await spawnPreview({ state: "live", port: 30100, burrowId: "bur_a" });
		const sidecars = fakeSidecars();
		const broker = new RunEventBroker();
		const previews = createRunPreviewsRepo(db);

		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			broker,
			now: () => new Date("2026-05-14T18:30:00.000Z"),
			resolveSidecar: sidecars.resolver,
			actor: "ui",
		});

		expect(result.tornDown).toBe(true);
		expect(result.status).toBe("torn-down");
		expect(result.previousState).toBe("live");
		expect(result.port).toBe(30100);

		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
		expect(reread.previewPort).toBeNull();

		expect(sidecars.deletions).toEqual([{ burrowId: "bur_a", sidecarId: "sc_bur_a" }]);

		const events = await repos.events.listByRun(runId);
		const tornDown = events.find((e) => e.kind === PREVIEW_TORN_DOWN_EVENT_KIND);
		expect(tornDown).toBeDefined();
		expect(tornDown?.stream).toBe("system");
		expect(tornDown?.payloadJson).toEqual({
			actor: "ui",
			port: 30100,
			previousState: "live",
		});
	});

	test("tears down a `starting` preview the same way", async () => {
		const runId = await spawnPreview({ state: "starting", port: 30101, burrowId: "bur_b" });
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		expect(result.tornDown).toBe(true);
		expect(result.previousState).toBe("starting");
		expect(result.port).toBe(30101);

		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
		expect(reread.previewPort).toBeNull();
	});

	test("idempotent against an already-torn-down row (no event, no sidecar call)", async () => {
		const runId = await spawnPreview({ state: "torn-down", port: null, burrowId: "bur_c" });
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		expect(result.tornDown).toBe(false);
		expect(result.status).toBe("already-torn-down");
		expect(result.previousState).toBe("torn-down");
		expect(sidecars.deletions).toEqual([]);
		expect(sidecars.listsCalled).toEqual([]);

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === PREVIEW_TORN_DOWN_EVENT_KIND)).toHaveLength(0);
	});

	test("idempotent against a `failed` row (already-failed, no event)", async () => {
		const runId = await spawnPreview({ state: "failed", port: null, burrowId: "bur_d" });
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		expect(result.tornDown).toBe(false);
		expect(result.status).toBe("already-failed");
		expect(result.previousState).toBe("failed");
		expect(sidecars.deletions).toEqual([]);

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === PREVIEW_TORN_DOWN_EVENT_KIND)).toHaveLength(0);
	});

	test("returns `never-launched` for a run that never opted into a preview", async () => {
		const runId = await spawnPreview({});
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		expect(result.tornDown).toBe(false);
		expect(result.status).toBe("never-launched");
		expect(result.previousState).toBeNull();
		expect(sidecars.deletions).toEqual([]);
	});

	test("404s when the runId is unknown (before the CAS runs)", async () => {
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		await expect(
			teardownPreview({
				runId: "run_unknown",
				repos,
				previews,
				burrowClientPool: emptyPool(repos),
				resolveSidecar: sidecars.resolver,
			}),
		).rejects.toThrow(NotFoundError);
		expect(sidecars.deletions).toEqual([]);
		expect(sidecars.listsCalled).toEqual([]);
	});

	test("sidecar.delete failure is logged but the route still succeeds", async () => {
		const runId = await spawnPreview({ state: "live", port: 30102, burrowId: "bur_e" });
		const sidecars = fakeSidecars();
		// Pre-seed two sidecars and fail one of them.
		sidecars.listingsBySidecar.set("bur_e", ["sc_a", "sc_b"]);
		sidecars.deleteFailures.add("sc_a");

		const warnings: { obj: Record<string, unknown>; msg?: string }[] = [];
		const logger = {
			info: () => {},
			warn: (obj: Record<string, unknown>, msg?: string) => warnings.push({ obj, msg }),
			error: () => {},
		};

		const previews = createRunPreviewsRepo(db);
		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
			logger,
		});

		expect(result.tornDown).toBe(true);
		// The successful one still got deleted.
		expect(sidecars.deletions).toEqual([{ burrowId: "bur_e", sidecarId: "sc_b" }]);
		// The failure surfaced as a warn line.
		const sidecarDeleteFailures = warnings.filter(
			(w) => w.msg === "preview_teardown.sidecar_delete_failed",
		);
		expect(sidecarDeleteFailures).toHaveLength(1);
	});

	test("sidecar.list throwing is logged via sidecar_stop_failed; teardown still completes", async () => {
		const runId = await spawnPreview({ state: "live", port: 30103, burrowId: "bur_f" });
		const sidecars = fakeSidecars();
		sidecars.listFailures.add("bur_f");

		const warnings: { obj: Record<string, unknown>; msg?: string }[] = [];
		const logger = {
			info: () => {},
			warn: (obj: Record<string, unknown>, msg?: string) => warnings.push({ obj, msg }),
			error: () => {},
		};

		const previews = createRunPreviewsRepo(db);
		const result = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
			logger,
		});

		expect(result.tornDown).toBe(true);
		const failures = warnings.filter((w) => w.msg === "preview_teardown.sidecar_stop_failed");
		expect(failures).toHaveLength(1);

		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
	});

	test("calling teardown twice in a row only emits one event (idempotent at the SQL layer)", async () => {
		const runId = await spawnPreview({ state: "live", port: 30104, burrowId: "bur_g" });
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		const first = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});
		const second = await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		expect(first.tornDown).toBe(true);
		expect(second.tornDown).toBe(false);
		expect(second.status).toBe("already-torn-down");

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === PREVIEW_TORN_DOWN_EVENT_KIND)).toHaveLength(1);
	});

	test("publishes the audit event through the broker so live subscribers see it", async () => {
		const runId = await spawnPreview({ state: "live", port: 30105, burrowId: "bur_h" });
		const sidecars = fakeSidecars();
		const broker = new RunEventBroker();
		const subscription = broker.subscribe(runId);
		const previews = createRunPreviewsRepo(db);

		await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			broker,
			resolveSidecar: sidecars.resolver,
		});

		// Close the broker so the subscriber's generator drains and returns.
		broker.close(runId);
		const collected: string[] = [];
		for await (const ev of subscription) {
			collected.push(ev.kind);
		}
		expect(collected).toContain(PREVIEW_TORN_DOWN_EVENT_KIND);
	});

	test("defaults the audit actor to `manual` when no actor is supplied", async () => {
		const runId = await spawnPreview({ state: "live", port: 30106, burrowId: "bur_i" });
		const sidecars = fakeSidecars();
		const previews = createRunPreviewsRepo(db);

		await teardownPreview({
			runId,
			repos,
			previews,
			burrowClientPool: emptyPool(repos),
			resolveSidecar: sidecars.resolver,
		});

		const events = await repos.events.listByRun(runId);
		const tornDown = events.find((e) => e.kind === PREVIEW_TORN_DOWN_EVENT_KIND);
		expect(tornDown?.payloadJson).toMatchObject({ actor: "manual" });
	});
});

describe("RunPreviewsRepo.claimTeardown", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	async function makeRun(opts: {
		state?: "starting" | "live" | "failed" | "torn-down" | null;
		port?: number | null;
		burrowId?: string;
	}): Promise<string> {
		const run = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: opts.burrowId ?? "bur_x",
		});
		if (opts.state !== undefined) {
			await repos.runs.attachPreview(run.id, {
				previewState: opts.state,
				...(opts.port !== undefined ? { previewPort: opts.port } : {}),
				previewStartedAt: "2026-05-14T18:00:00.000Z",
			});
		}
		return run.id;
	}

	test("starting/live → torn-down clears the port and returns previous state", async () => {
		const runId = await makeRun({ state: "live", port: 30200, burrowId: "bur_live" });
		const previews = createRunPreviewsRepo(db);
		const result = await previews.claimTeardown({ runId });
		expect(result.status).toBe("torn-down");
		expect(result.previousState).toBe("live");
		expect(result.port).toBe(30200);
		expect(result.burrowId).toBe("bur_live");
		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
		expect(reread.previewPort).toBeNull();
	});

	test("torn-down → already-torn-down with previous state intact", async () => {
		const runId = await makeRun({ state: "torn-down", port: null });
		const previews = createRunPreviewsRepo(db);
		const result = await previews.claimTeardown({ runId });
		expect(result.status).toBe("already-torn-down");
		expect(result.previousState).toBe("torn-down");
	});

	test("failed → already-failed with previous state intact", async () => {
		const runId = await makeRun({ state: "failed", port: null });
		const previews = createRunPreviewsRepo(db);
		const result = await previews.claimTeardown({ runId });
		expect(result.status).toBe("already-failed");
		expect(result.previousState).toBe("failed");
	});

	test("null preview_state → never-launched", async () => {
		const runId = await makeRun({});
		const previews = createRunPreviewsRepo(db);
		const result = await previews.claimTeardown({ runId });
		expect(result.status).toBe("never-launched");
		expect(result.previousState).toBeNull();
	});

	test("missing row → never-launched (race-with-deletion fallback)", async () => {
		const previews = createRunPreviewsRepo(db);
		const result = await previews.claimTeardown({ runId: "run_gone" });
		expect(result.status).toBe("never-launched");
		expect(result.previousState).toBeNull();
	});
});
