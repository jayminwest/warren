import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { isId } from "../../core/ids.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { RuntimeUnreachableError } from "../../runtime/errors.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { composeDispatchPrompt, spawnRun } from "./index.ts";
import { isRunScopedToken, verifyRunScopedToken } from "./run-token.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

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
		const { client, calls } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "   ",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("throws NotFoundError when the agent is not registered", async () => {
		const { client, calls } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "no-such-agent",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("throws NotFoundError when the project does not exist", async () => {
		const { client } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_doesnotexist",
				prompt: "fix it",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("spawnRun: end-to-end", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("end-to-end: creates the warren run, provisions+seeds the burrow atomically, dispatches", async () => {
		const { client, calls } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
		});

		expect(isId("run", result.run.id)).toBe(true);
		expect(result.run.state).toBe("queued");
		expect(result.run.sandboxId).toBe("bur_aaaaaaaaaaaa");
		expect(result.run.sandboxRunId).toBe("run_zzzzzzzzzzzz");
		const reread = await repos.runs.require(result.run.id);
		expect(reread.sandboxId).toBe("bur_aaaaaaaaaaaa");
		expect(reread.sandboxRunId).toBe("run_zzzzzzzzzzzz");

		const stored = reread.renderedAgentJson as { name: string; sections: Record<string, string> };
		expect(stored.name).toBe("refactor-bot");
		expect(stored.sections.system).toBe("be a refactor agent");

		// Two HTTP calls: provision-with-seed, then dispatch. The seed.files
		// payload rides on POST /sandboxes so provisioning + workspace drops are
		// atomic — burrow rolls back if any file is rejected (R-07).
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			method: "POST",
			path: "/sandboxes/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "pi",
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
		expect(upBody.agents).toEqual(["pi"]);
		const seededPaths = (upBody.seed?.files ?? []).map((f) => f.path);
		expect(seededPaths).toContain(".warren/agent.json");

		// warren-3743: worker_id is nullified for new runs (the workers/sandboxes
		// placement tables were dropped); the burrow correlation ids are still
		// written for LocalProvider resume.
		expect(reread.workerId).toBeNull();
	});

	test("leaves worker_id NULL and writes the burrow ids for new runs (warren-3743)", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = await repos.runs.require(result.run.id);
		expect(stored.workerId).toBeNull();
		expect(stored.sandboxId).toBe(result.sandbox.id);
		expect(stored.sandboxRunId).toBe(result.sandboxRun.id);
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

		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			metadata: { runByOperator: "alice" },
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/sandboxes",
			body: {
				projectRoot: "/data/projects/x/y",
				originUrl: "https://github.com/x/y.git",
				network: "restricted",
				// refactor-bot pins no runtime → pi default (warren-16f8).
				agents: ["pi"],
			},
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/sandboxes/bur_aaaaaaaaaaaa/runs",
			body: {
				agentId: "pi",
				prompt: "s\n\n---\n\np",
				metadata: { runByOperator: "alice", frontmatter: {} },
			},
		});
	});

	test("dispatch uses frontmatter.runtime as the burrow runtime id when set (warren-ebca)", async () => {
		// Planner is a canopy agent whose name (`planner`) is NOT a burrow
		// runtime id; without `frontmatter.runtime`, dispatchRun would send
		// `"planner"` and burrow would fail with `agent 'planner' is not
		// registered`. The fix routes the dispatch onto the declared runtime.
		await repos.agents.upsert({
			name: "planner",
			renderedJson: makeAgentJson({
				name: "planner",
				sections: { system: "be a scout" },
				frontmatter: { source: "builtin", runtime: "claude-code" },
			}),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "planner",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "help me think",
		});
		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		expect((dispatch?.body as { agentId: string }).agentId).toBe("claude-code");
		// warren-53e6: the same runtime id has to ride on the `up` call so
		// burrow's collectToolchainPaths mounts claude's binary into the
		// sandbox. Without this, bwrap fails `execvp claude: No such file or
		// directory` ~17s into the run.
		const up = calls.find((c) => c.path === "/sandboxes");
		expect(up).toBeDefined();
		expect((up?.body as { agents: readonly string[] }).agents).toEqual(["claude-code"]);
	});

	test("dispatch falls back to the pi default when frontmatter.runtime is unset (warren-16f8)", async () => {
		// pi is the preferred default: an agent that pins no runtime
		// resolves to `pi` via readRuntimeId rather than its canopy name.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: {} }),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
		expect((dispatch?.body as { agentId: string }).agentId).toBe("pi");
	});

	// warren-c4be: a legacy row whose runtime id predates registration-time
	// validation must fail at the dispatch boundary (AgentSchemaError -> 422),
	// never sandbox-side after provisioning (the warren-ebca incident class).
	test("dispatch rejects a legacy row with an unknown runtime id before provisioning", async () => {
		await repos.agents.upsert({
			name: "legacy-bot",
			renderedJson: makeAgentJson({
				name: "legacy-bot",
				frontmatter: { source: "library", runtime: "legacy-bot" },
			}),
		});
		const { client, calls } = makeSandboxClient();
		expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "legacy-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toThrow(/is not a known runtime id/);
		expect(calls.find((c) => c.path === "/sandboxes")).toBeUndefined();
	});

	test("forwards agent.frontmatter as burrow run metadata so piRuntime gets provider/model (warren-d34e)", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-opus-4-7" },
			}),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
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
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
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
		// Bun's default cache dir is <cwd>/.bun/install/cache, so agents doing
		// `git add .` sweep ~5k cache files into commits; pinning it to /tmp
		// keeps it off the git index for every project, every agent.
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: { WARREN_API_TOKEN: "tok_secret", WARREN_BIND_PORT: "9090" },
		});
		const up = calls.find((c) => c.path === "/sandboxes");
		expect(up).toBeDefined();
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env).toBeDefined();
		expect(env?.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
		// warren-57fd: the sandbox gets a per-run SCOPED callback token, NOT the
		// operator token — signed with the operator token, bound to this run.
		expect(env?.WARREN_API_TOKEN).toBeDefined();
		expect(env?.WARREN_API_TOKEN).not.toBe("tok_secret");
		expect(isRunScopedToken(env?.WARREN_API_TOKEN ?? "")).toBe(true);
		expect(verifyRunScopedToken(env?.WARREN_API_TOKEN ?? "", "tok_secret")).not.toBeNull();
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
		const { client, calls } = makeSandboxClient({
			sandboxUpStatus: 422,
			sandboxUpBody: {
				error: {
					code: "validation_error",
					message: "seed file rejected: workspace path escapes root",
				},
			},
		});
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("failed");
		expect(rows[0]?.sandboxId).toBeNull();
		expect(rows[0]?.sandboxRunId).toBeNull();

		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toEqual(["POST /sandboxes"]);
	});

	test("rolls back when burrow dispatch fails", async () => {
		const { client, calls } = makeSandboxClient({
			runsCreateStatus: 500,
			runsCreateBody: { error: { code: "internal_error", message: "boom" } },
		});
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeDefined();

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("failed");
		expect(rows[0]?.sandboxId).toBeNull(); // warren-1f56: provider owns burrow-half rollback
		expect(rows[0]?.sandboxRunId).toBeNull();
		const methods = calls.map((c) => `${c.method} ${c.path}`);
		expect(methods).toContain("DELETE /sandboxes/bur_aaaaaaaaaaaa");
	});

	test("propagates provider transport failures and leaves no warren row attached to a sandbox", async () => {
		const client = new FakeProvider({
			provisionError: new RuntimeUnreachableError("fetch failed"),
		});
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(RuntimeUnreachableError);

		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("failed");
		expect(rows[0]?.sandboxId).toBeNull();
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
