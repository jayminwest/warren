import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	BurrowClient,
	BurrowClientPool,
	BurrowUnreachableError,
} from "../../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { composeDispatchPrompt, spawnRun } from "./index.ts";
import { makeAgentJson, makeBurrowClient, makePool, setupRepos, stub } from "./test-helpers.ts";

describe("spawnRun: validation", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("rejects an empty prompt before touching db or burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "   ",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("throws NotFoundError when the agent is not registered", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "no-such-agent",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the project does not exist", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_doesnotexist",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("spawnRun: end-to-end + placement", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("end-to-end: creates the warren run, provisions+seeds the burrow atomically, dispatches", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
		});

		expect(isId("run", result.run.id)).toBe(true);
		expect(result.run.state).toBe("queued");
		expect(result.run.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.burrowRunId).toBe("run_zzzzzzzzzzzz");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.burrowRunId).toBe("run_zzzzzzzzzzzz");

		const stored = reread.renderedAgentJson as { name: string; sections: Record<string, string> };
		expect(stored.name).toBe("refactor-bot");
		expect(stored.sections.system).toBe("be a refactor agent");

		// Two HTTP calls: provision-with-seed, then dispatch. The seed.files
		// payload rides on POST /burrows so provisioning + workspace drops are
		// atomic — burrow rolls back if any file is rejected (R-07).
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "be a refactor agent\n\n---\n\nfix the flaky test",
				metadata: { frontmatter: {} },
			},
		});

		const upBody = calls[0]?.body as {
			projectRoot: string;
			originUrl: string;
			agents: readonly string[];
			seed?: { files: ReadonlyArray<{ path: string; contents: string }> };
		};
		expect(upBody.projectRoot).toBe("/data/projects/x/y");
		expect(upBody.originUrl).toBe("https://github.com/x/y.git");
		expect(upBody.agents).toEqual(["refactor-bot"]);
		const seededPaths = (upBody.seed?.files ?? []).map((f) => f.path);
		expect(seededPaths).toContain(".canopy/agent.json");

		expect(reread.workerId).toBe("local");
		const burrowRow = await repos.burrows.require("bur_aaaaaaaaaaaa");
		expect(burrowRow.workerId).toBe("local");
	});

	test("placement: writes worker_id under a non-default worker name (warren-39c3)", async () => {
		const { client } = makeBurrowClient();
		const pool = await makePool(repos, client, "alpha");
		const result = await spawnRun({
			repos,
			burrowClientPool: pool,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		expect((await repos.runs.require(result.run.id)).workerId).toBe("alpha");
		expect((await repos.burrows.require(result.burrow.id)).workerId).toBe("alpha");
	});

	test("placement: raises NoEligibleWorkerError when no healthy worker exists (warren-39c3)", async () => {
		const { client } = makeBurrowClient();
		// Pool with a registered client but no `healthy` worker row — drives
		// placeForProject into NoEligibleWorkerError before any burrow call.
		const pool = new BurrowClientPool({ repos });
		pool.register("local", client);
		await expect(
			spawnRun({
				repos,
				burrowClientPool: pool,
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toThrow(/no_eligible_worker|no healthy/);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});
});

describe("spawnRun: burrow_config + runtime + metadata", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("forwards burrow_config network and metadata onto the burrow calls", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({
				sections: {
					system: "s",
					burrow_config: `[sandbox]\nnetwork = "restricted"`,
				},
			}),
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			metadata: { runByOperator: "alice" },
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/burrows",
			body: {
				projectRoot: "/data/projects/x/y",
				originUrl: "https://github.com/x/y.git",
				network: "restricted",
				agents: ["refactor-bot"],
			},
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/burrows/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "refactor-bot",
				prompt: "s\n\n---\n\np",
				metadata: { runByOperator: "alice", frontmatter: {} },
			},
		});
	});

	test("dispatch uses frontmatter.runtime as the burrow runtime id when set (warren-ebca)", async () => {
		// Brainstorm/planner are canopy agents whose name (`brainstorm`)
		// is NOT a burrow runtime id; without `frontmatter.runtime`,
		// dispatchRun would send `"brainstorm"` and burrow would fail the
		// run with `agent 'brainstorm' is not registered`. The fix routes
		// the dispatch onto the declared runtime instead.
		await repos.agents.upsert({
			name: "brainstorm",
			renderedJson: makeAgentJson({
				name: "brainstorm",
				sections: { system: "be a scout" },
				frontmatter: { source: "builtin", runtime: "claude-code" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "brainstorm",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "help me think",
		});
		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { agentId: string }).agentId).toBe("claude-code");
		// warren-53e6: the same runtime id has to ride on the `up` call so
		// burrow's collectToolchainPaths mounts claude's binary into the
		// sandbox. Without this, bwrap fails `execvp claude: No such file or
		// directory` ~17s into the run.
		const up = calls.find((c) => c.path === "/burrows");
		expect(up).toBeDefined();
		expect((up?.body as { agents: readonly string[] }).agents).toEqual(["claude-code"]);
	});

	test("dispatch falls back to agent.name when frontmatter.runtime is unset (warren-ebca)", async () => {
		// claude-code / sapling / pi keep working: their name already
		// matches their burrow runtime id, so omitting `runtime` resolves
		// to `agent.name` via readRuntimeId().
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: {} }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect((dispatch?.body as { agentId: string }).agentId).toBe("refactor-bot");
	});

	test("forwards agent.frontmatter as burrow run metadata so piRuntime gets provider/model (warren-d34e)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-opus-4-7" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		expect(body.metadata.frontmatter.provider).toBe("anthropic");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
		expect(body.metadata.frontmatter.source).toBe("builtin");
	});

	test("dispatch metadata frontmatter reflects per-run + project-default overrides (warren-d34e)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		// Operator override wins for provider; project default wins for model.
		expect(body.metadata.frontmatter.provider).toBe("openai");
		expect(body.metadata.frontmatter.model).toBe("claude-opus-4-7");
	});
});

describe("spawnRun: sandbox env (warren-b893)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("always injects BUN_INSTALL_CACHE_DIR into the burrow env (warren-b893)", async () => {
		// Bun's default cache dir is <cwd>/.bun/install/cache; inside the
		// workspace that means agents doing `git add .` sweep ~5k cache files
		// into their commits. Pinning BUN_INSTALL_CACHE_DIR to /tmp keeps it
		// off the git index for every project, every agent.
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
		});
		const up = calls.find((c) => c.path === "/burrows");
		expect(up).toBeDefined();
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env).toBeDefined();
		expect(env?.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
	});

	test("BUN_INSTALL_CACHE_DIR is still set when plot env vars are also injected (warren-b893)", async () => {
		await repos.projects.create({
			id: "prj_withplot",
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
			hasPlot: true,
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_withplot",
			plotId: "plt_001",
			prompt: "fix it",
		});
		const up = calls.find((c) => c.path === "/burrows");
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env?.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
		expect(env?.PLOT_ID).toBe("plt_001");
		expect(env?.PLOT_ACTOR).toMatch(/^agent:refactor-bot:run_/);
	});
});

describe("spawnRun: rollback", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("rolls back: cancels the warren row when burrow rejects the seed payload (atomic rollback, R-07)", async () => {
		const { client, calls } = makeBurrowClient({
			burrowsUpStatus: 422,
			burrowsUpBody: {
				error: {
					code: "validation_error",
					message: "seed file rejected: workspace path escapes root",
				},
			},
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
		expect(rows[0]?.burrowRunId).toBeNull();

		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toEqual(["POST /burrows"]);
	});

	test("rolls back when burrow dispatch fails", async () => {
		const { client, calls } = makeBurrowClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBe("bur_aaaaaaaaaaaa");
		expect(rows[0]?.burrowRunId).toBeNull();
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("DELETE /burrows/bur_aaaaaaaaaaaa");
	});

	test("propagates burrow transport failures and leaves no warren row attached to a burrow", async () => {
		const errFetch = stub(async () => {
			const e = new TypeError("fetch failed");
			(e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
			throw e;
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: errFetch,
		});
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(BurrowUnreachableError);

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("cancelled");
		expect(rows[0]?.burrowId).toBeNull();
	});
});

describe("composeDispatchPrompt", () => {
	test("prepends the system body with a horizontal-rule delimiter", () => {
		expect(composeDispatchPrompt("be a refactor agent", "fix it")).toBe(
			"be a refactor agent\n\n---\n\nfix it",
		);
	});

	test("trims trailing whitespace on the system body before joining", () => {
		expect(composeDispatchPrompt("system\n\n\n", "task")).toBe("system\n\n---\n\ntask");
	});

	test("returns the user prompt verbatim when system is empty or whitespace", () => {
		expect(composeDispatchPrompt("", "task")).toBe("task");
		expect(composeDispatchPrompt("   \n\t", "task")).toBe("task");
		expect(composeDispatchPrompt(undefined, "task")).toBe("task");
	});
});
