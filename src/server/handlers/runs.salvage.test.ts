import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "../../runtime/k8s/finalize-wire.ts";
import { MAX_SALVAGE_BUNDLE_BYTES } from "../../runtime/salvage.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

/**
 * HTTP coverage for the salvage intake (warren-cd3b):
 *   POST /runs/:id/salvage — the pod's salvage-before-exit capture lands here:
 *   the bundle is stored durably, the run row is stamped with the recovery
 *   location, and a `reap.workspace_salvaged` event surfaces it to operators.
 */

function inertBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(
			async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
		),
	});
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		trigger: "push_failed",
		rescueRef: null,
		bundleBase64: Buffer.from("fake-bundle-bytes").toString("base64"),
		branch: "warren/run_x",
		baseBranch: "main",
		notes: [],
		...over,
	};
}

describe("POST /runs/:id/salvage (warren-cd3b)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let salvageDir: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		salvageDir = await mkdtemp(join(tmpdir(), "warren-salvage-test-"));
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		await rm(salvageDir, { recursive: true, force: true });
	});

	async function serveWith(opts: { salvageDir?: string } = {}): Promise<string> {
		const deps = await depsFor(repos, inertBurrowClient(), undefined, {
			...(opts.salvageDir !== undefined ? { salvageDir: opts.salvageDir } : {}),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	async function createRun(id = "run_x"): Promise<string> {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/acme/widgets.git",
			localPath: "/tmp/widgets",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			id,
			agentName: "claude-code",
			projectId: project.id,
			renderedAgentJson: {},
			prompt: "fix",
			trigger: "test",
		});
		return run.id;
	}

	test("stores the bundle durably, stamps the run row, and emits the salvaged event", async () => {
		const runId = await createRun();
		const base = await serveWith({ salvageDir });
		const res = await fetch(`${base}/runs/${runId}/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope({ rescueRef: "warren/rescue/run_x" })),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stored: boolean; rescueRef: string | null };
		expect(body.stored).toBe(true);
		expect(body.rescueRef).toBe("warren/rescue/run_x");

		// The durable artifact: the bundle file on the warren-side volume.
		const stored = await readFile(join(salvageDir, `${runId}.bundle`));
		expect(stored.toString()).toBe("fake-bundle-bytes");

		// The run object carries the recovery location.
		const row = await repos.runs.require(runId);
		expect(row.salvageRef).toBe("warren/rescue/run_x");
		expect(row.salvagePath).toBe(join(salvageDir, `${runId}.bundle`));

		// …and the event stream surfaces it.
		const events = await repos.events.listByKind("reap.workspace_salvaged");
		const mine = events.filter((e) => e.runId === runId);
		expect(mine).toHaveLength(1);
		const payload = mine[0]?.payloadJson as { trigger: string; rescueRef: string | null };
		expect(payload.trigger).toBe("push_failed");
		expect(payload.rescueRef).toBe("warren/rescue/run_x");
	});

	test("an envelope without a bundle still records the rescue ref", async () => {
		const runId = await createRun();
		const base = await serveWith({ salvageDir });
		const res = await fetch(`${base}/runs/${runId}/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope({ bundleBase64: null, rescueRef: "warren/rescue/run_x" })),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { stored: boolean }).stored).toBe(false);
		const row = await repos.runs.require(runId);
		expect(row.salvageRef).toBe("warren/rescue/run_x");
		expect(row.salvagePath).toBeNull();
	});

	test("a retried POST is idempotent — same file, same stamp, still 200", async () => {
		const runId = await createRun();
		const base = await serveWith({ salvageDir });
		for (let i = 0; i < 2; i++) {
			const res = await fetch(`${base}/runs/${runId}/salvage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(envelope()),
			});
			expect(res.status).toBe(200);
		}
		const stored = await readFile(join(salvageDir, `${runId}.bundle`));
		expect(stored.toString()).toBe("fake-bundle-bytes");
	});

	test("a malformed envelope is a 400 the pod can log", async () => {
		const runId = await createRun();
		const base = await serveWith({ salvageDir });
		const res = await fetch(`${base}/runs/${runId}/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: 99, trigger: "push_failed" }),
		});
		expect(res.status).toBe(400);
	});

	test("an over-cap bundle is rejected before it touches disk", async () => {
		const runId = await createRun();
		const base = await serveWith({ salvageDir });
		const res = await fetch(`${base}/runs/${runId}/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				envelope({
					bundleBase64: Buffer.alloc(MAX_SALVAGE_BUNDLE_BYTES + 1).toString("base64"),
				}),
			),
		});
		expect(res.status).toBe(400);
	});

	test("a deleted run row still stores the bundle (the capture outlives the row)", async () => {
		const base = await serveWith({ salvageDir });
		const res = await fetch(`${base}/runs/run_ghost/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope()),
		});
		expect(res.status).toBe(200);
		const stored = await readFile(join(salvageDir, "run_ghost.bundle"));
		expect(stored.toString()).toBe("fake-bundle-bytes");
	});

	test("an unconfigured intake fails LOUD (never silently drops the only copy)", async () => {
		const runId = await createRun();
		const base = await serveWith(); // no salvageDir
		const res = await fetch(`${base}/runs/${runId}/salvage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope()),
		});
		expect(res.status).toBe(500);
	});
});
