import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makeProvider, setupRepos, stub } from "./test-helpers.ts";
import type { SpawnLogger } from "./types.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: Record<string, unknown>;
	readonly msg?: string;
}

/**
 * Recording `SpawnLogger` that mirrors pino's `child` binding semantics:
 * `child(bindings)` returns a logger whose every line carries those
 * bindings merged in, so the test can assert `run_id` rides along on the
 * post-placement lines without the caller re-passing it (warren-c686).
 */
function makeRecordingLogger(bound: Record<string, unknown> = {}): {
	logger: SpawnLogger;
	lines: LogLine[];
} {
	const lines: LogLine[] = [];
	const make = (bindings: Record<string, unknown>): SpawnLogger => ({
		info: (obj, msg) => lines.push({ level: "info", obj: { ...bindings, ...obj }, msg }),
		warn: (obj, msg) => lines.push({ level: "warn", obj: { ...bindings, ...obj }, msg }),
		error: (obj, msg) => lines.push({ level: "error", obj: { ...bindings, ...obj }, msg }),
		child: (extra) => make({ ...bindings, ...(extra as Record<string, unknown>) }),
	});
	return { logger: make(bound), lines };
}

describe("spawnRun: instrumentation (warren-c686)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("logs placement, provision, and dispatch with run_id and request_id", async () => {
		const { client } = makeBurrowClient();
		const { logger, lines } = makeRecordingLogger({ request_id: "req_abc" });
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			logger,
		});

		const byEvent = (event: string) => lines.find((l) => l.obj.event === event);

		const placement = byEvent("spawn.placement");
		expect(placement?.obj.worker_id).toBe("local");
		expect(placement?.obj.request_id).toBe("req_abc");

		const provisioned = byEvent("spawn.provisioned");
		expect(provisioned?.obj.run_id).toBe(result.run.id);
		expect(provisioned?.obj.request_id).toBe("req_abc");
		expect(provisioned?.obj.burrow_id).toBe(result.burrow.id);
		expect(typeof provisioned?.obj.duration_ms).toBe("number");

		const dispatched = byEvent("spawn.dispatched");
		expect(dispatched?.obj.run_id).toBe(result.run.id);
		expect(dispatched?.obj.burrow_run_id).toBe(result.burrowRun.id);
		expect(typeof dispatched?.obj.duration_ms).toBe("number");
	});

	test("logs the rollback branch when burrow dispatch fails", async () => {
		const { client } = makeBurrowClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		const { logger, lines } = makeRecordingLogger({ request_id: "req_fail" });
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				logger,
			}),
		).rejects.toBeDefined();

		const failed = lines.find((l) => l.obj.event === "spawn.failed");
		expect(failed?.level).toBe("warn");
		expect(failed?.obj.request_id).toBe("req_fail");
		expect(typeof failed?.obj.run_id).toBe("string");
	});

	test("logs spawn.failed and rolls back when provision succeeds but dispatch fails", async () => {
		// warren-1f56: provision+dispatch are collapsed into `provider.create`,
		// which owns the burrow-half rollback (best-effort DELETE) and swallows a
		// destroy failure ITSELF — so the domain no longer emits
		// `spawn.rollback.burrow_destroy_failed`. Provision succeeds, dispatch AND
		// the provider's cleanup DELETE both throw; the domain surfaces the
		// original failure as `spawn.failed` and unwinds the warren row.
		let call = 0;
		const fetchImpl = stub(async (input, init) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			call += 1;
			if (method === "POST" && path === "/burrows") {
				return new Response(
					JSON.stringify({
						id: "bur_aaaaaaaaaaaa",
						parentId: null,
						kind: "task",
						name: null,
						projectRoot: "/data/projects/x/y",
						workspacePath: "/w",
						branch: "b",
						provider: "local",
						providerStateJson: null,
						profileJson: {},
						state: "active",
						createdAt: "2026-05-08T12:00:00Z",
						updatedAt: "2026-05-08T12:00:00Z",
						destroyedAt: null,
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}
			// Both the dispatch (POST .../runs) and the destroy (DELETE) throw.
			const e = new TypeError("fetch failed");
			(e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw e;
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: fetchImpl,
		});
		const { logger, lines } = makeRecordingLogger();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				logger,
			}),
		).rejects.toBeDefined();

		// burrowsUp + runs.create + the provider's cleanup DELETE all fired.
		expect(call).toBeGreaterThan(1);
		// The domain surfaces the dispatch failure it saw rethrown…
		const failed = lines.find((l) => l.obj.event === "spawn.failed");
		expect(failed?.level).toBe("warn");
		// …and does NOT log a burrow-destroy failure — that cleanup is now the
		// provider's, which swallows it silently (see create.test.ts).
		expect(
			lines.find((l) => l.obj.event === "spawn.rollback.burrow_destroy_failed"),
		).toBeUndefined();
		// The warren row was rolled back to failed with no burrow attached.
		const rows = await repos.runs.listAll();
		expect(rows[0]?.state).toBe("failed");
		expect(rows[0]?.burrowId).toBeNull();
	});
});
