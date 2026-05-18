import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool, BurrowUnreachableError } from "../burrow-client/index.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "./events.ts";
import { steerRun } from "./steer.ts";

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly; the per-burrow
 * `burrows` row is seeded by the test that needs it.
 */
async function makePool(
	client: BurrowClient,
	repos: Repos,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client);
	return pool;
}

function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

interface InboxFetchPlan {
	message?: Partial<Message>;
	status?: number;
	body?: unknown;
}

function makeBurrowClient(plan: InboxFetchPlan = {}): {
	client: BurrowClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = stub(async (input, init) => {
		const url = new URL(String(input), "http://localhost");
		const path = url.pathname;
		const method = init?.method ?? "GET";
		const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body: reqBody });
		if (method === "POST" && path.match(/^\/burrows\/[^/]+\/inbox$/)) {
			const message: Message = {
				id: "msg_aaaaaaaaaaaa",
				burrowId: "bur_aaaaaaaaaaaa",
				fromActor: "operator",
				body:
					typeof reqBody === "object" && reqBody !== null
						? String((reqBody as { body?: unknown }).body ?? "")
						: "",
				priority: "normal",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date("2026-05-08T12:00:00Z"),
				deliveredAt: null,
				...plan.message,
			};
			return jsonResponse(plan.status ?? 201, plan.body ?? serializeMessage(message));
		}
		return jsonResponse(404, {
			error: { code: "not_found", message: `unmatched ${method} ${path}` },
		});
	});
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
	return { client, calls };
}

function serializeMessage(m: Message): unknown {
	return {
		...m,
		createdAt: m.createdAt.toISOString(),
		deliveredAt: m.deliveredAt?.toISOString() ?? null,
	};
}

describe("steerRun", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
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

	async function createRunningRun(
		opts: { burrowId?: string | null; burrowRunId?: string | null } = {},
	): Promise<string> {
		const burrowId = opts.burrowId === undefined ? "bur_aaaaaaaaaaaa" : opts.burrowId;
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId,
			burrowRunId: opts.burrowRunId === undefined ? "run_zzzzzzzzzzzz" : opts.burrowRunId,
		});
		await repos.runs.markRunning(run.id);
		if (burrowId !== null && (await repos.burrows.get(burrowId)) === null) {
			await repos.burrows.create({ id: burrowId, workerId: "local" });
		}
		return run.id;
	}

	test("rejects an empty body before touching db or burrow", async () => {
		const runId = await createRunningRun();
		const { client, calls } = makeBurrowClient();
		await expect(
			steerRun({ runId, body: "   ", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("throws NotFoundError when the run is not registered", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			steerRun({
				runId: "run_doesnotexist",
				body: "hi",
				repos,
				burrowClientPool: await makePool(client, repos),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("rejects when the run has no burrow_id (partial spawn window)", async () => {
		const runId = (
			await repos.runs.create({
				agentName: "refactor-bot",
				projectId,
				prompt: "p",
				renderedAgentJson: {},
				trigger: "manual",
			})
		).id;
		const { client, calls } = makeBurrowClient();
		await expect(
			steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("rejects when the run is in a terminal state", async () => {
		const runId = await createRunningRun();
		await repos.runs.finalize(runId, "succeeded");
		const { client, calls } = makeBurrowClient();
		await expect(
			steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("forwards body, priority, and fromActor onto the burrow inbox call", async () => {
		const runId = await createRunningRun();
		const { client, calls } = makeBurrowClient({
			message: { priority: "high", fromActor: "alice" },
		});
		const result = await steerRun({
			runId,
			body: "stop and write tests",
			priority: "high",
			fromActor: "alice",
			repos,
			burrowClientPool: await makePool(client, repos),
		});
		expect(result.message.id).toBe("msg_aaaaaaaaaaaa");
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/burrows/bur_aaaaaaaaaaaa/inbox",
				body: {
					body: "stop and write tests",
					priority: "high",
					fromActor: "alice",
				},
			},
		]);
	});

	test("appends a steer.sent system event to the run's event log", async () => {
		const runId = await createRunningRun();
		const { client } = makeBurrowClient({ message: { priority: "urgent" } });
		await steerRun({
			runId,
			body: "remember to lint",
			priority: "urgent",
			repos,
			burrowClientPool: await makePool(client, repos),
		});
		const events = await repos.events.listByRun(runId);
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toBeDefined();
		if (!event) throw new Error("no event");
		expect(event.kind).toBe("steer.sent");
		expect(event.stream).toBe("system");
		expect(event.burrowEventSeq).toBe(1);
		const payload = event.payloadJson as {
			messageId: string;
			priority: string;
			fromActor: string;
			body: string;
		};
		expect(payload.messageId).toBe("msg_aaaaaaaaaaaa");
		expect(payload.priority).toBe("urgent");
		expect(payload.body).toBe("remember to lint");
	});

	test("audit event seq starts at MAX(seq) + 1 when prior events exist", async () => {
		const runId = await createRunningRun();
		await repos.events.append({
			runId,
			burrowEventSeq: 7,
			ts: "2026-05-08T12:00:00Z",
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		const { client } = makeBurrowClient();
		await steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) });
		const events = await repos.events.listByRun(runId);
		const sent = events.find((e) => e.kind === "steer.sent");
		expect(sent).toBeDefined();
		expect(sent?.burrowEventSeq).toBe(8);
	});

	test("publishes the audit event to the broker for live tailers", async () => {
		const runId = await createRunningRun();
		const broker = new RunEventBroker();
		const sub = broker.subscribe(runId);
		const consumed: string[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.kind);
				if (consumed.length >= 1) break;
			}
		})();
		const { client } = makeBurrowClient();
		await steerRun({
			runId,
			body: "hi",
			repos,
			burrowClientPool: await makePool(client, repos),
			broker,
		});
		await consumer;
		expect(consumed).toEqual(["steer.sent"]);
	});

	test("does not change the run's state", async () => {
		const runId = await createRunningRun();
		const { client } = makeBurrowClient();
		await steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) });
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("steers a queued run that already has a burrow_id", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		const { client, calls } = makeBurrowClient();
		await steerRun({
			runId: run.id,
			body: "hi",
			repos,
			burrowClientPool: await makePool(client, repos),
		});
		expect(calls[0]?.path).toBe("/burrows/bur_aaaaaaaaaaaa/inbox");
		expect((await repos.runs.require(run.id)).state).toBe("queued");
	});

	test("transport errors are mapped to BurrowUnreachableError", async () => {
		const runId = await createRunningRun();
		const fetchImpl = stub(async () => {
			throw new TypeError("fetch failed");
		});
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: fetchImpl,
		});
		await expect(
			steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(BurrowUnreachableError);
		// No audit event was emitted for a failed forward.
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("server-side burrow errors propagate without emitting an audit event", async () => {
		const runId = await createRunningRun();
		const { client } = makeBurrowClient({
			status: 400,
			body: { error: { code: "validation_error", message: "body too long" } },
		});
		await expect(
			steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toThrow();
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("warren-b1a9: burrow 404 on inbox surfaces as ValidationError (run is lost)", async () => {
		const runId = await createRunningRun();
		const { client } = makeBurrowClient({
			status: 404,
			body: { error: { code: "not_found", message: "burrow bur_aaaaaaaaaaaa not found" } },
		});
		await expect(
			steerRun({ runId, body: "hi", repos, burrowClientPool: await makePool(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		// No audit event — steering a ghost run is rejected, not recorded.
		expect(await repos.events.countByRun(runId)).toBe(0);
	});
});
