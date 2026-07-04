import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Run as BurrowRun, Message } from "@os-eco/burrow-cli";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { AutoOpenPrConfig } from "../../runs/pr.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

/**
 * HTTP-layer coverage for `steerRunHandler` and `cancelRunHandler`
 * (warren-1b93). The core `steerRun` / `cancelRun` functions are exercised
 * in `src/runs/steer.test.ts` and `src/runs/cancel.test.ts`; this file
 * covers the thin HTTP envelope — param/body parsing, the optional-field
 * spreads, and the wire response shapes — by routing real `fetch` calls
 * through `startServer` against a stubbed burrow client wired via the
 * shared `runs.test-helpers.ts` harness.
 *
 * The cancel stub returns a non-terminal burrow run state so the inline
 * reap path inside `cancelRun` is not triggered — reap is covered
 * separately in `src/runs/cancel.test.ts`, and pulling it in here would
 * couple these handler assertions to reap's workspace-lookup sub-steps.
 */

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

interface PauseResumeFixture {
	burrowId: string;
	burrowRunId: string;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function serializeMessage(m: Message): unknown {
	return {
		...m,
		createdAt: m.createdAt.toISOString(),
		deliveredAt: m.deliveredAt?.toISOString() ?? null,
	};
}

function serializeRun(r: BurrowRun): unknown {
	return {
		...r,
		queuedAt: r.queuedAt.toISOString(),
		startedAt: r.startedAt?.toISOString() ?? null,
		completedAt: r.completedAt?.toISOString() ?? null,
	};
}

/**
 * Burrow client whose fetch stub answers the two endpoints the pause/
 * resume handlers hit — `POST /burrows/:id/inbox` (steer) and
 * `POST /runs/:id/cancel` (cancel) — and records every call so tests can
 * assert on the forwarded wire body. Anything else falls through to a 404
 * so an accidental extra wire call surfaces loudly.
 */
function makePauseResumeClient(fix: PauseResumeFixture, calls: RecordedCall[]): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === `/burrows/${fix.burrowId}/inbox`) {
				const message: Message = {
					id: "msg_aaaaaaaaaaaa",
					burrowId: fix.burrowId,
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
				};
				return jsonResponse(201, serializeMessage(message));
			}
			if (method === "POST" && path === `/runs/${fix.burrowRunId}/cancel`) {
				// Non-terminal state keeps cancelRun off the inline reap path
				// (warren-a69a) so these handler tests stay reap-isolated.
				const run: BurrowRun = {
					id: fix.burrowRunId,
					burrowId: fix.burrowId,
					agentId: "refactor-bot",
					prompt: "p",
					resumeOfRunId: null,
					state: "running",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: new Date("2026-05-08T12:00:00Z"),
					startedAt: null,
					completedAt: null,
				};
				return jsonResponse(200, serializeRun(run));
			}
			return jsonResponse(404, {
				error: { code: "not_found", message: `unmatched ${method} ${path}` },
			});
		}),
	});
}

const DISABLED_AUTO_OPEN_PR: AutoOpenPrConfig = {
	enabled: false,
	token: "",
	warrenBaseUrl: null,
};

describe("POST /runs/:id/steer and POST /runs/:id/cancel — HTTP handlers", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId: string;

	const fix: PauseResumeFixture = {
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
	};

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
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	/** Create a running run pinned to the fixture burrow + burrow run. */
	async function createRunningRun(): Promise<string> {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: fix.burrowId,
			burrowRunId: fix.burrowRunId,
		});
		await repos.runs.markRunning(run.id);
		await repos.burrows.create({ id: fix.burrowId, workerId: "local" });
		return run.id;
	}

	describe("POST /runs/:id/steer", () => {
		test("forwards the required body and returns 200 { message }", async () => {
			const runId = await createRunningRun();
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			});

			const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ body: "stop and write tests" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { message: { id: string } };
			expect(body.message.id).toBe("msg_aaaaaaaaaaaa");
			// Optional priority + fromActor are absent → not spread onto the
			// inbox wire body.
			expect(calls).toEqual([
				{
					method: "POST",
					path: `/burrows/${fix.burrowId}/inbox`,
					body: { body: "stop and write tests" },
				},
			]);
		});

		test("forwards optional priority and fromActor onto the burrow inbox call", async () => {
			const runId = await createRunningRun();
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			// Thread `deps.now` so the `deps.now !== undefined` spread branch
			// is taken (the body-only test above leaves it undefined).
			const fixedNow = new Date("2026-07-04T10:00:00Z");
			handle = startServer(
				{ ...deps, now: () => fixedNow },
				{
					transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
					auth: NO_AUTH,
					logger: silentLogger,
				},
			);

			const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					body: "remember to lint",
					priority: "high",
					fromActor: "alice",
				}),
			});
			expect(res.status).toBe(200);
			expect(calls).toEqual([
				{
					method: "POST",
					path: `/burrows/${fix.burrowId}/inbox`,
					body: {
						body: "remember to lint",
						priority: "high",
						fromActor: "alice",
					},
				},
			]);
		});
	});

	describe("POST /runs/:id/cancel", () => {
		test("accepts an empty body and returns 200 with no reason forwarded", async () => {
			const runId = await createRunningRun();
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			});

			const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/cancel`, {
				method: "POST",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				state: string;
				alreadyTerminal: boolean;
				burrowRun: { id: string; state: string } | null;
			};
			expect(body.state).toBe("running");
			expect(body.alreadyTerminal).toBe(false);
			expect(body.burrowRun?.id).toBe(fix.burrowRunId);
			expect(body.burrowRun?.state).toBe("running");
			// No reason key on the wire — `HttpRunsClient.cancel` omits the
			// jsonBody entirely when `opts.reason` is undefined.
			expect(calls).toEqual([
				{
					method: "POST",
					path: `/runs/${fix.burrowRunId}/cancel`,
					body: undefined,
				},
			]);
		});

		test("forwards the reason onto the burrow cancel call", async () => {
			const runId = await createRunningRun();
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			// Thread `deps.now` + `deps.autoOpenPr` so their spread branches
			// are taken (the empty-body test above leaves both undefined).
			const fixedNow = new Date("2026-07-04T10:00:00Z");
			handle = startServer(
				{ ...deps, now: () => fixedNow, autoOpenPr: DISABLED_AUTO_OPEN_PR },
				{
					transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
					auth: NO_AUTH,
					logger: silentLogger,
				},
			);

			const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/cancel`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason: "operator changed their mind" }),
			});
			expect(res.status).toBe(200);
			expect(calls).toEqual([
				{
					method: "POST",
					path: `/runs/${fix.burrowRunId}/cancel`,
					body: { reason: "operator changed their mind" },
				},
			]);
		});

		test("returns alreadyTerminal passthrough for a terminal run with no burrow call", async () => {
			const runId = await createRunningRun();
			await repos.runs.finalize(runId, "succeeded");
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			});

			const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/cancel`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason: "too late" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				state: string;
				alreadyTerminal: boolean;
				burrowRun: unknown;
			};
			expect(body.state).toBe("succeeded");
			expect(body.alreadyTerminal).toBe(true);
			expect(body.burrowRun).toBeNull();
			// `cancelRun` short-circuits on a terminal row — no wire call.
			expect(calls).toHaveLength(0);
		});
	});
});
