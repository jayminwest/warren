import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { PlotCreator, PlotResolver, PlotSyncer } from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { NO_AUTH } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";

const silentLogger = { info() {}, warn() {}, error() {} };

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Call {
	method: string;
	path: string;
	body: unknown;
}

function makeBurrowClient(
	fix: { burrowId: string; burrowRunId: string; workspacePath: string },
	calls: Call[],
): BurrowClient {
	let burrowCounter = 0;
	let runCounter = 0;
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				burrowCounter++;
				const burrowId = `${fix.burrowId}_${burrowCounter}`;
				return jsonRes(201, {
					id: burrowId,
					name: "burrow",
					kind: "task",
					projectRoot: "/data/projects/x/y",
					branch: "main",
					baseBranch: "main",
					originUrl: "https://github.com/x/y.git",
					workspacePath: fix.workspacePath,
					provider: "local",
					sandbox: { network: "open" },
					state: "running",
					createdAt: "2026-05-08T12:00:00Z",
					updatedAt: "2026-05-08T12:00:00Z",
				});
			}
			const matchRuns = path.match(/^\/burrows\/([^/]+)\/runs$/);
			if (method === "POST" && matchRuns) {
				const burrowId = matchRuns[1];
				runCounter++;
				const burrowRunId = `${fix.burrowRunId}_${runCounter}`;
				return jsonRes(201, {
					id: burrowRunId,
					burrowId: burrowId,
					agentId: "leveret",
					prompt: "hello",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: "2026-05-08T12:00:01Z",
					startedAt: null,
					completedAt: null,
				});
			}
			const matchInbox = path.match(/^\/burrows\/([^/]+)\/inbox$/);
			if (method === "POST" && matchInbox) {
				const burrowId = matchInbox[1];
				return jsonRes(201, {
					id: "msg_inbox00000",
					burrowId: burrowId,
					fromActor: "operator",
					body: String((reqBody as { body?: unknown })?.body ?? ""),
					priority: "normal",
					state: "unread",
					deliveredAtRunId: null,
					createdAt: "2026-05-08T12:00:02Z",
					deliveredAt: null,
				});
			}
			return jsonRes(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});
}

async function poolFor(repos: Repos, client: BurrowClient): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register("local", client);
	return pool;
}

interface DepsExtras {
	plotCreator?: PlotCreator;
	plotResolver?: PlotResolver;
	plotSyncer?: PlotSyncer;
}

async function depsFor(
	repos: Repos,
	burrowClient: BurrowClient,
	extras: DepsExtras = {},
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const burrowClientPool = await poolFor(repos, burrowClient);
	return {
		repos,
		burrowClientPool,
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			burrowClientPool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		canopyConfig: {
			repoUrl: "https://example/agents.git",
			localDir: "/tmp/cn",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		...(extras.plotCreator !== undefined ? { plotCreator: extras.plotCreator } : {}),
		...(extras.plotResolver !== undefined ? { plotResolver: extras.plotResolver } : {}),
		...(extras.plotSyncer !== undefined ? { plotSyncer: extras.plotSyncer } : {}),
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

const PLOT_CREATOR: PlotCreator = {
	async create() {
		return {
			id: "plot-conv00000",
			name: "Conversation",
			status: "drafting" as const,
			intent_goal_preview: "",
			attachments_count: 0,
			last_event_ts: "2026-05-23T00:00:00Z",
			last_event_actor: "user:operator",
		};
	},
};

describe("conversation re-wake endpoints", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "leveret",
			renderedJson: {
				name: "leveret",
				version: 1,
				sections: { system: "you are leveret" },
				resolvedFrom: [],
				frontmatter: { runtime: "pi-chat" },
			},
		});
		const localPath = await mkdtemp(join(tmpdir(), "warren-conv-"));
		await require("node:fs/promises").mkdir(join(localPath, ".plot"), { recursive: true });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath,
			defaultBranch: "main",
			hasPlot: true,
		});
		projectId = project.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function boot(extras: DepsExtras = {}): Promise<string> {
		const ws = await mkdtemp(join(tmpdir(), "warren-conv-ws-"));
		const client = makeBurrowClient(
			{ burrowId: "bur_conv0000000", burrowRunId: "run_conv0000000", workspacePath: ws },
			[],
		);
		const deps = await depsFor(repos, client, extras);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	async function createConversation(url: string): Promise<{ id: string; plotId: string }> {
		const created = (await (
			await fetch(`${url}/conversations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			})
		).json()) as { conversation: { id: string; plotId: string } };
		return { id: created.conversation.id, plotId: created.conversation.plotId };
	}

	test("POST /conversations/:id/re-wake rotates anchoringRunId + returns 200 on terminal anchoring run", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const conv = await createConversation(url);

		const before = await repos.conversations.require(conv.id);
		const priorRunId = before.anchoringRunId ?? "";

		// Finalize the anchoring run to make it terminal.
		await repos.runs.markRunning(priorRunId);
		await repos.runs.finalize(priorRunId, "succeeded");

		const res = await fetch(`${url}/conversations/${conv.id}/re-wake`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider_override: "local-provider",
				model_override: "local-model",
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversation: { id: string; anchoringRunId: string; status: string };
			run: { id: string; mode: string };
		};

		expect(body.conversation.status).toBe("active");
		expect(body.run.mode).toBe("conversation");
		expect(body.conversation.anchoringRunId).toBe(body.run.id);
		expect(body.conversation.anchoringRunId).not.toBe(priorRunId);

		// Verify the database row also carried the rotation.
		const after = await repos.conversations.require(conv.id);
		expect(after.anchoringRunId).toBe(body.run.id);
	});

	test("POST /conversations/:id/re-wake 400s when the anchoring run is still live", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const conv = await createConversation(url);

		const res = await fetch(`${url}/conversations/${conv.id}/re-wake`, { method: "POST" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("POST /conversations/:id/re-wake 404s on unknown conversation", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const res = await fetch(`${url}/conversations/conv_missing0000/re-wake`, { method: "POST" });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("not_found");
	});
});
