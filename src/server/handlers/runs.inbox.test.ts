import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, NO_AUTH, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * HTTP-layer coverage for `GET /runs/:id/inbox` — the in-pod steering poll
 * (warren-3d0b). The claim ordering + atomicity live in
 * `src/db/repos/run-inbox.test.ts`; this file covers the route: auth gating,
 * the poll-consume wire shape, and 404 on an unknown run.
 */

/** A burrow client that 404s everything — the inbox poll never touches burrow. */
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("GET /runs/:id/inbox — HTTP handler", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
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

	async function createRun(): Promise<string> {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		return run.id;
	}

	async function serveWith(auth = NO_AUTH): Promise<string> {
		const deps = await depsFor(repos, inertSandboxClient());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("claims unread messages priority-desc then FIFO and consumes them", async () => {
		const runId = await createRun();
		await repos.runInbox.enqueue({ runId, body: "n1", priority: "normal" });
		await repos.runInbox.enqueue({ runId, body: "u1", priority: "urgent" });
		await repos.runInbox.enqueue({ runId, body: "n2", priority: "normal" });
		const base = await serveWith();

		const res = await fetch(`${base}/runs/${runId}/inbox`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			messages: { body: string; state: string; runId: string | null }[];
		};
		expect(body.messages.map((m) => m.body)).toEqual(["u1", "n1", "n2"]);
		// Delivered rows carry the claiming run as attribution.
		for (const m of body.messages) {
			expect(m.state).toBe("delivered");
			expect(m.runId).toBe(runId);
		}

		// Poll-consume: a second poll drains nothing.
		const res2 = await fetch(`${base}/runs/${runId}/inbox`);
		const body2 = (await res2.json()) as { messages: unknown[] };
		expect(body2.messages).toEqual([]);
	});

	test("?peek=1 lists the unread queue WITHOUT claiming it (warren-3305)", async () => {
		const runId = await createRun();
		await repos.runInbox.enqueue({ runId, body: "n1", priority: "normal" });
		await repos.runInbox.enqueue({ runId, body: "u1", priority: "urgent" });
		const base = await serveWith();

		const res = await fetch(`${base}/runs/${runId}/inbox?peek=1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: { body: string; state: string }[] };
		// Delivery order, still unread, and nothing claimed.
		expect(body.messages.map((m) => m.body)).toEqual(["u1", "n1"]);
		expect(body.messages.map((m) => m.state)).toEqual(["unread", "unread"]);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual([
			"unread",
			"unread",
		]);
		expect(await repos.events.countByRun(runId)).toBe(0);

		// The pod's later bare poll still claims the queue exactly once.
		const claim = await fetch(`${base}/runs/${runId}/inbox`);
		const claimed = (await claim.json()) as { messages: { body: string }[] };
		expect(claimed.messages.map((m) => m.body)).toEqual(["u1", "n1"]);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual([
			"delivered",
			"delivered",
		]);
	});

	test("a claiming poll emits one steer.delivered event per message (warren-3305)", async () => {
		const runId = await createRun();
		await repos.runInbox.enqueue({ runId, body: "n1", priority: "normal" });
		const base = await serveWith();

		const res = await fetch(`${base}/runs/${runId}/inbox`);
		expect(res.status).toBe(200);
		const events = (await repos.events.listByRun(runId)).filter(
			(e) => e.kind === "steer.delivered",
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.stream).toBe("system");
	});

	test("returns 404 for an unknown run", async () => {
		const base = await serveWith();
		const res = await fetch(`${base}/runs/run_missing/inbox`);
		expect(res.status).toBe(404);
	});

	test("is bearer-gated like every /runs route", async () => {
		const runId = await createRun();
		await repos.runInbox.enqueue({ runId, body: "secret steer" });
		const base = await serveWith(bearerAuth("s3cret"));

		// No Authorization header → 401, and the message stays unread.
		const denied = await fetch(`${base}/runs/${runId}/inbox`);
		expect(denied.status).toBe(401);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["unread"]);

		// Correct bearer → 200 and the message drains.
		const ok = await fetch(`${base}/runs/${runId}/inbox`, {
			headers: { authorization: "Bearer s3cret" },
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { messages: { body: string }[] };
		expect(body.messages.map((m) => m.body)).toEqual(["secret steer"]);
	});

	test("a public-read spectator is refused BEFORE the queue is drained (warren-b875)", async () => {
		// This route is the reason the policy table is not just about
		// disclosure: the poll is destructive on read (`src/runs/inbox.ts`
		// claims unread rows and flips them to `delivered`), so an anonymous
		// caller reaching it would silently drain the operator's steering
		// queue — an availability bug, not a leak. The 403 must land before
		// the handler runs.
		const runId = await createRun();
		await repos.runInbox.enqueue({ runId, body: "steer me" });
		const base = await serveWith(publicReadAuth(bearerAuth("s3cret")));

		const denied = await fetch(`${base}/runs/${runId}/inbox`);
		expect(denied.status).toBe(403);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["unread"]);

		// Repeated polls can't grind the queue down either.
		for (let i = 0; i < 3; i++) {
			expect((await fetch(`${base}/runs/${runId}/inbox`)).status).toBe(403);
		}
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["unread"]);

		// The operator still drains it.
		const ok = await fetch(`${base}/runs/${runId}/inbox`, {
			headers: { authorization: "Bearer s3cret" },
		});
		expect(ok.status).toBe(200);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["delivered"]);
	});
});
