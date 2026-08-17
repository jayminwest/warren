import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, StateTransitionError, ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { AgentSchemaError } from "../registry/errors.ts";
import type { Message, RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError, RuntimeUnreachableError } from "../runtime/errors.ts";
import {
	type FakeProvider,
	type FakeProviderCall,
	makeFakeProvider,
} from "../runtime/fake/fake-provider.ts";
import { RunEventBroker } from "./events.ts";
import { steerRun } from "./steer.ts";

/**
 * The provider seam `steerRun` speaks (pl-829f step 13; re-based onto the
 * contract-typed `FakeProvider` in warren-ea0a when the burrow facade left).
 * `steerRun` calls only `provider.sendMessage`; the fake records the inbox
 * call and returns the canned message row.
 */
async function makeProvider(client: FakeProvider, _repos: Repos): Promise<RuntimeProvider> {
	return client;
}

interface InboxFetchPlan {
	/** Overrides on the `Message` row `sendMessage` returns. */
	message?: Partial<Message>;
	/** 400 ⇒ a backend validation failure; 404 ⇒ backend run-not-found. */
	status?: number;
}

function makeSandboxClient(plan: InboxFetchPlan = {}): {
	client: FakeProvider;
	calls: FakeProviderCall[];
} {
	const sendMessageError =
		plan.status === 404
			? new RuntimeRunNotFoundError("burrow bur_aaaaaaaaaaaa not found", {
					recoveryHint: "the run is unknown to the backend; reconcile the warren row as lost",
				})
			: plan.status !== undefined
				? new Error("body too long")
				: undefined;
	const client = makeFakeProvider({
		...(plan.message !== undefined ? { message: plan.message } : {}),
		...(sendMessageError !== undefined ? { sendMessageError } : {}),
	});
	return { client, calls: client.calls };
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
		opts: {
			sandboxId?: string | null;
			sandboxRunId?: string | null;
			renderedAgentJson?: unknown;
		} = {},
	): Promise<string> {
		const sandboxId = opts.sandboxId === undefined ? "bur_aaaaaaaaaaaa" : opts.sandboxId;
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: opts.renderedAgentJson ?? {},
			trigger: "manual",
			sandboxId,
			sandboxRunId: opts.sandboxRunId === undefined ? "run_zzzzzzzzzzzz" : opts.sandboxRunId,
		});
		await repos.runs.markRunning(run.id);
		return run.id;
	}

	/** A frozen agent definition carrying the given `frontmatter.steering` value. */
	function renderedWithSteering(steering: unknown): unknown {
		return { sections: { system: "x" }, frontmatter: { steering } };
	}

	test("rejects an empty body before touching db or burrow", async () => {
		const runId = await createRunningRun();
		const { client, calls } = makeSandboxClient();
		await expect(
			steerRun({ runId, body: "   ", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("throws NotFoundError when the run is not registered", async () => {
		const { client, calls } = makeSandboxClient();
		await expect(
			steerRun({
				runId: "run_doesnotexist",
				body: "hi",
				repos,
				runtimeProvider: await makeProvider(client, repos),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("rejects when the run has no sandbox_id (partial spawn window)", async () => {
		const runId = (
			await repos.runs.create({
				agentName: "refactor-bot",
				projectId,
				prompt: "p",
				renderedAgentJson: {},
				trigger: "manual",
			})
		).id;
		const { client, calls } = makeSandboxClient();
		await expect(
			steerRun({ runId, body: "hi", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("rejects when the run is in a terminal state", async () => {
		const runId = await createRunningRun();
		await repos.runs.finalize(runId, "succeeded");
		const { client, calls } = makeSandboxClient();
		await expect(
			steerRun({ runId, body: "hi", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(calls).toHaveLength(0);
	});

	test("rejects 409 when the harness declares steering: none (warren-3305)", async () => {
		const runId = await createRunningRun({ renderedAgentJson: renderedWithSteering("none") });
		const { client, calls } = makeSandboxClient();
		const err = await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StateTransitionError);
		expect((err as Error).message).toContain("cannot consume steering");
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("rejects 409 steering a running spawn-only harness (warren-3305)", async () => {
		const runId = await createRunningRun({
			renderedAgentJson: renderedWithSteering("spawn-only"),
		});
		const { client, calls } = makeSandboxClient();
		const err = await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(StateTransitionError);
		expect((err as Error).message).toContain("only consumes steering at spawn");
		expect(calls).toHaveLength(0);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("allows steering a queued spawn-only run (message folds into the spawn prompt)", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: renderedWithSteering("spawn-only"),
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_zzzzzzzzzzzz",
		});
		const { client, calls } = makeSandboxClient();
		const result = await steerRun({
			runId: run.id,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.message.body).toBe("hi");
		expect(calls).toHaveLength(1);
	});

	test("allows a mid-run-capable harness on a running run", async () => {
		const runId = await createRunningRun({ renderedAgentJson: renderedWithSteering("mid-run") });
		const { client, calls } = makeSandboxClient();
		const result = await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.message.body).toBe("hi");
		expect(calls).toHaveLength(1);
	});

	test("fails loudly on a malformed steering capability in the frozen definition", async () => {
		const runId = await createRunningRun({ renderedAgentJson: renderedWithSteering("sometimes") });
		const { client, calls } = makeSandboxClient();
		await expect(
			steerRun({
				runId,
				body: "hi",
				repos,
				runtimeProvider: await makeProvider(client, repos),
			}),
		).rejects.toBeInstanceOf(AgentSchemaError);
		expect(calls).toHaveLength(0);
	});

	test("an agent without a steering declaration stays fail-open (legacy behavior)", async () => {
		const runId = await createRunningRun({
			renderedAgentJson: { sections: { system: "x" }, frontmatter: { runtime: "pi" } },
		});
		const { client, calls } = makeSandboxClient();
		const result = await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.message.body).toBe("hi");
		expect(calls).toHaveLength(1);
	});

	test("forwards body, priority, and fromActor onto the burrow inbox call", async () => {
		const runId = await createRunningRun();
		const { client, calls } = makeSandboxClient({
			message: { priority: "high", fromActor: "alice" },
		});
		const result = await steerRun({
			runId,
			body: "stop and write tests",
			priority: "high",
			fromActor: "alice",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(result.message.id).toBe("msg_aaaaaaaaaaaa");
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/sandboxes/bur_aaaaaaaaaaaa/inbox",
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
		const { client } = makeSandboxClient({ message: { priority: "urgent" } });
		await steerRun({
			runId,
			body: "remember to lint",
			priority: "urgent",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		const events = await repos.events.listByRun(runId);
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toBeDefined();
		if (!event) throw new Error("no event");
		expect(event.kind).toBe("steer.sent");
		expect(event.stream).toBe("system");
		expect(event.sandboxEventSeq).toBe(1);
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
			sandboxEventSeq: 7,
			ts: "2026-05-08T12:00:00Z",
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		const { client } = makeSandboxClient();
		await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		const events = await repos.events.listByRun(runId);
		const sent = events.find((e) => e.kind === "steer.sent");
		expect(sent).toBeDefined();
		expect(sent?.sandboxEventSeq).toBe(8);
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
		const { client } = makeSandboxClient();
		await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
			broker,
		});
		await consumer;
		expect(consumed).toEqual(["steer.sent"]);
	});

	test("does not change the run's state", async () => {
		const runId = await createRunningRun();
		const { client } = makeSandboxClient();
		await steerRun({
			runId,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("steers a queued run that already has a sandbox_id", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
		});
		const { client, calls } = makeSandboxClient();
		await steerRun({
			runId: run.id,
			body: "hi",
			repos,
			runtimeProvider: await makeProvider(client, repos),
		});
		expect(calls[0]?.path).toBe("/sandboxes/bur_aaaaaaaaaaaa/inbox");
		expect((await repos.runs.require(run.id)).state).toBe("queued");
	});

	test("transport errors surface as RuntimeUnreachableError", async () => {
		const runId = await createRunningRun();
		const client = makeFakeProvider({
			sendMessageError: new RuntimeUnreachableError("fetch failed"),
		});
		await expect(
			steerRun({ runId, body: "hi", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(RuntimeUnreachableError);
		// No audit event was emitted for a failed forward.
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("server-side burrow errors propagate without emitting an audit event", async () => {
		const runId = await createRunningRun();
		const { client } = makeSandboxClient({ status: 400 });
		await expect(
			steerRun({ runId, body: "hi", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toThrow();
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("warren-b1a9: burrow 404 on inbox surfaces as ValidationError (run is lost)", async () => {
		const runId = await createRunningRun();
		const { client } = makeSandboxClient({ status: 404 });
		await expect(
			steerRun({ runId, body: "hi", repos, runtimeProvider: await makeProvider(client, repos) }),
		).rejects.toBeInstanceOf(ValidationError);
		// No audit event — steering a ghost run is rejected, not recorded.
		expect(await repos.events.countByRun(runId)).toBe(0);
	});
});
