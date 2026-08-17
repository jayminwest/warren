import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunHandle, RunSpec } from "../../runtime/contract.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { IdempotencyStore } from "../idempotency.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * `POST /runs` idempotency (warren-d525). A duplicate delivery carrying
 * the same `Idempotency-Key` (within the window, same project) must reuse
 * the original run instead of spawning a second burrow + agent.
 */

/**
 * Provider fake that mints a FRESH sandbox + run id on every `create` so two
 * real spawns don't collide on a duplicate primary key. The
 * `sandboxCreateCount` it returns is the spawn signal the dedupe assertions
 * key on: one logical dispatch must reach `create` exactly once.
 */
function countingBurrowClient(workspacePath: string): {
	client: FakeProvider;
	sandboxCreateCount: () => number;
} {
	class CountingProvider extends FakeProvider {
		private n = 0;
		override create(spec: RunSpec): Promise<RunHandle> {
			this.n += 1;
			const id = `bur_${String(this.n).padStart(12, "0")}`;
			this.plan.sandboxId = id;
			this.plan.providerRunId = `run_${String(this.n).padStart(12, "0")}`;
			return super.create(spec);
		}
	}
	const client = new CountingProvider({ workspacePath });
	return {
		client,
		sandboxCreateCount: () => client.calls.filter((c) => c.path === "/sandboxes").length,
	};
}

interface DispatchResponse {
	run: { id: string };
	sandbox: { id: string };
}

async function postRun(
	handle: ServeHandle,
	projectId: string,
	idempotencyKey?: string,
): Promise<DispatchResponse> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
	const res = await fetch(`${tcpUrl(handle)}/runs`, {
		method: "POST",
		headers,
		body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "hello" }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as DispatchResponse;
}

describe("POST /runs — Idempotency-Key dedupe (warren-d525)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let workspacePath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectLocalPath = await mkdtemp(join(tmpdir(), "warren-idem-proj-"));
		workspacePath = await mkdtemp(join(tmpdir(), "warren-idem-ws-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function startWith(deps: ServerDeps): Promise<ServeHandle> {
		const h = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		handle = h;
		return h;
	}

	test("same key within window spawns once; both responses reference it", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, sandboxCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "dispatch-abc");
		const second = await postRun(h, project.id, "dispatch-abc");

		expect(sandboxCreateCount()).toBe(1);
		expect(second.run.id).toBe(first.run.id);
		expect(second.sandbox.id).toBe(first.sandbox.id);
		expect((await repos.runs.listAll()).length).toBe(1);
	});

	test("different key spawns a new run", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, sandboxCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "key-1");
		const second = await postRun(h, project.id, "key-2");

		expect(sandboxCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("same key after the window expires spawns a new run", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, sandboxCreateCount } = countingBurrowClient(workspacePath);
		let clock = 1_000_000;
		const store = new IdempotencyStore({ ttlMs: 1000, now: () => clock });
		const deps: ServerDeps = { ...(await depsFor(repos, client)), idempotencyStore: store };
		const h = await startWith(deps);

		const first = await postRun(h, project.id, "windowed");
		clock += 5000;
		const second = await postRun(h, project.id, "windowed");

		expect(sandboxCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("no header preserves always-spawn behavior", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const { client, sandboxCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const first = await postRun(h, project.id);
		const second = await postRun(h, project.id);

		expect(sandboxCreateCount()).toBe(2);
		expect(second.run.id).not.toBe(first.run.id);
	});

	test("same key but different project is not deduped", async () => {
		const projectA = (await repos.projects.listAll())[0];
		if (!projectA) throw new Error("project missing");
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const otherLocalPath = await mkdtemp(join(tmpdir(), "warren-idem-proj2-"));
		await repos.projects.create({
			gitUrl: "https://github.com/x/z.git",
			localPath: otherLocalPath,
			defaultBranch: "main",
		});
		const projectB = (await repos.projects.listAll()).find((p) => p.id !== projectA.id);
		if (!projectB) throw new Error("second project missing");

		const { client, sandboxCreateCount } = countingBurrowClient(workspacePath);
		const deps: ServerDeps = {
			...(await depsFor(repos, client)),
			idempotencyStore: new IdempotencyStore(),
		};
		const h = await startWith(deps);

		const a = await postRun(h, projectA.id, "shared-key");
		const b = await postRun(h, projectB.id, "shared-key");

		expect(sandboxCreateCount()).toBe(2);
		expect(b.run.id).not.toBe(a.run.id);
	});
});
