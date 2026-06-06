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
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				return jsonRes(201, {
					id: fix.burrowId,
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
			if (method === "POST" && path === `/burrows/${fix.burrowId}/runs`) {
				return jsonRes(201, {
					id: fix.burrowRunId,
					burrowId: fix.burrowId,
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
			if (method === "POST" && path.match(/^\/burrows\/[^/]+\/inbox$/)) {
				return jsonRes(201, {
					id: "msg_inbox00000",
					burrowId: fix.burrowId,
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

describe("conversation endpoints", () => {
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

	test("POST /conversations auto-creates a Plot and dispatches an anchoring conversation run", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const res = await fetch(`${url}/conversations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: projectId, title: "Shape it" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			conversation: { id: string; plotId: string; anchoringRunId: string; status: string };
			run: { id: string; mode: string };
		};
		expect(body.conversation.status).toBe("active");
		expect(body.conversation.plotId).toBe("plot-conv00000");
		expect(body.run.mode).toBe("conversation");
		expect(body.conversation.anchoringRunId).toBe(body.run.id);

		// The anchoring run is hidden from the Runs API.
		const runsRes = await fetch(`${url}/runs`);
		const runsBody = (await runsRes.json()) as { runs: unknown[]; total: number };
		expect(runsBody.runs).toHaveLength(0);
		expect(runsBody.total).toBe(0);

		// The opening turn was persisted to the transcript.
		const messages = await repos.messages.listByConversation(body.conversation.id);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	test("POST /conversations attaches to an existing plot_id", async () => {
		const url = await boot();
		const res = await fetch(`${url}/conversations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id: projectId, plot_id: "plot-existing0" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { conversation: { plotId: string } };
		expect(body.conversation.plotId).toBe("plot-existing0");
	});

	test("GET /conversations lists and GET /conversations/:id returns the transcript", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const created = (await (
			await fetch(`${url}/conversations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			})
		).json()) as { conversation: { id: string } };

		const listRes = await fetch(`${url}/conversations?project=${projectId}`);
		const list = (await listRes.json()) as { conversations: { id: string }[] };
		expect(list.conversations.map((c) => c.id)).toContain(created.conversation.id);

		const getRes = await fetch(`${url}/conversations/${created.conversation.id}`);
		const got = (await getRes.json()) as {
			conversation: { id: string };
			messages: { role: string }[];
		};
		expect(got.conversation.id).toBe(created.conversation.id);
		expect(got.messages).toHaveLength(1);
	});

	test("POST /conversations/:id/messages persists the turn and steers the run", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const created = (await (
			await fetch(`${url}/conversations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			})
		).json()) as { conversation: { id: string } };

		const res = await fetch(`${url}/conversations/${created.conversation.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "let's focus on the CLI" }),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			conversationId: string;
			message: { seq: number };
			steerMessageId: string;
		};
		expect(body.conversationId).toBe(created.conversation.id);
		expect(body.message.seq).toBe(2);
		expect(body.steerMessageId).toBe("msg_inbox00000");

		const messages = await repos.messages.listByConversation(created.conversation.id);
		expect(messages.map((m) => m.content)).toContain("let's focus on the CLI");
	});

	test("POST /conversations/:id/messages 400s on a closed conversation", async () => {
		const url = await boot({ plotCreator: PLOT_CREATOR });
		const created = (await (
			await fetch(`${url}/conversations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			})
		).json()) as { conversation: { id: string } };
		await repos.conversations.close(created.conversation.id);

		const res = await fetch(`${url}/conversations/${created.conversation.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "too late" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /conversations/:id 404s for an unknown id", async () => {
		const url = await boot();
		const res = await fetch(`${url}/conversations/conv_missing0000`);
		expect(res.status).toBe(404);
	});

	async function resolverForProject(): Promise<PlotResolver> {
		const project = await repos.projects.require(projectId);
		return {
			async resolve() {
				return project;
			},
		};
	}

	const SYNCED_SYNCER: PlotSyncer = {
		async sync() {
			return {
				kind: "synced",
				branch: "warren/plot-sync-abc123",
				prUrl: "https://github.com/x/y/pull/42",
				prNumber: 42,
				merged: false,
			};
		},
	};

	const NOOP_SYNCER: PlotSyncer = {
		async sync() {
			return { kind: "no_op" };
		},
	};

	async function createConversation(url: string): Promise<{ id: string; plotId: string }> {
		const created = (await (
			await fetch(`${url}/conversations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ project_id: projectId }),
			})
		).json()) as { conversation: { id: string; plotId: string } };
		return created.conversation;
	}

	test("POST /conversations/:id/send-off opens a plotSync PR, closes the conversation, and persists the submission", async () => {
		const url = await boot({
			plotCreator: PLOT_CREATOR,
			plotResolver: await resolverForProject(),
			plotSyncer: SYNCED_SYNCER,
		});
		const conv = await createConversation(url);

		const res = await fetch(`${url}/conversations/${conv.id}/send-off`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ planner_agent: "claude-code" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversation: {
				status: string;
				submittedPrUrl: string;
				submittedPrNumber: number;
				plannerAgent: string;
				closedAt: string | null;
			};
			plot_id: string;
			pr: { url: string; number: number };
			planner_agent: string;
		};
		expect(body.conversation.status).toBe("closed");
		expect(body.conversation.submittedPrUrl).toBe("https://github.com/x/y/pull/42");
		expect(body.conversation.submittedPrNumber).toBe(42);
		expect(body.conversation.plannerAgent).toBe("claude-code");
		expect(body.conversation.closedAt).not.toBeNull();
		expect(body.plot_id).toBe(conv.plotId);
		expect(body.pr.number).toBe(42);
		expect(body.planner_agent).toBe("claude-code");

		// Persisted on the row.
		const row = await repos.conversations.require(conv.id);
		expect(row.status).toBe("closed");
		expect(row.submittedPrUrl).toBe("https://github.com/x/y/pull/42");
		expect(row.plannerAgent).toBe("claude-code");
	});

	test("POST /conversations/:id/send-off 400s when there is no plot-state change to submit", async () => {
		const url = await boot({
			plotCreator: PLOT_CREATOR,
			plotResolver: await resolverForProject(),
			plotSyncer: NOOP_SYNCER,
		});
		const conv = await createConversation(url);

		const res = await fetch(`${url}/conversations/${conv.id}/send-off`, { method: "POST" });
		expect(res.status).toBe(400);

		// Conversation stays active — nothing was submitted.
		const row = await repos.conversations.require(conv.id);
		expect(row.status).toBe("active");
		expect(row.submittedPrUrl).toBeNull();
	});

	test("POST /conversations/:id/send-off 400s on an already-closed conversation", async () => {
		const url = await boot({
			plotCreator: PLOT_CREATOR,
			plotResolver: await resolverForProject(),
			plotSyncer: SYNCED_SYNCER,
		});
		const conv = await createConversation(url);
		await repos.conversations.close(conv.id);

		const res = await fetch(`${url}/conversations/${conv.id}/send-off`, { method: "POST" });
		expect(res.status).toBe(400);
	});
});
