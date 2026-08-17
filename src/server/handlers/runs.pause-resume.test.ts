import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INBOX_PRIORITIES } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { AutoOpenPrConfig } from "../../runs/pr.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

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
	sandboxId: string;
	sandboxRunId: string;
}

/**
 * Provider fake for the pause/resume handler tests (warren-ea0a). Steer
 * records the inbox call and echoes the body on the returned message; the
 * status snapshot stays `running` so cancel keeps off the inline-reap path
 * (warren-a69a). Every call is recorded so tests can assert on the
 * forwarded body.
 */
function makePauseResumeClient(fix: PauseResumeFixture, calls: RecordedCall[]): FakeProvider {
	return new FakeProvider(
		{
			sandboxId: fix.sandboxId,
			providerRunId: fix.sandboxRunId,
			statusValue: {
				phase: "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: true,
			},
		},
		undefined,
		calls,
	);
}

const DISABLED_AUTO_OPEN_PR: AutoOpenPrConfig = {
	enabled: false,
	warrenBaseUrl: null,
};

describe("POST /runs/:id/steer and POST /runs/:id/cancel — HTTP handlers", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId: string;

	const fix: PauseResumeFixture = {
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
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
			sandboxId: fix.sandboxId,
			sandboxRunId: fix.sandboxRunId,
		});
		await repos.runs.markRunning(run.id);
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
					path: `/sandboxes/${fix.sandboxId}/inbox`,
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
					path: `/sandboxes/${fix.sandboxId}/inbox`,
					body: {
						body: "remember to lint",
						priority: "high",
						fromActor: "alice",
					},
				},
			]);
		});

		test("rejects an unknown priority with 400 and sends nothing to burrow", async () => {
			// warren-b27c: `{"priority":"CRITICAL"}` used to sail past an unchecked
			// cast, persist verbatim, and make the inbox comparator return NaN.
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
				body: JSON.stringify({ body: "do it", priority: "CRITICAL" }),
			});
			expect(res.status).toBe(400);
			const err = (await res.json()) as { error: { message: string } };
			expect(err.error.message).toContain("priority");
			// Nothing forwarded, nothing persisted.
			expect(calls).toEqual([]);
			expect(await repos.runInbox.listByRun(runId)).toEqual([]);
		});

		test("rejects a non-string priority with 400", async () => {
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
				body: JSON.stringify({ body: "do it", priority: 3 }),
			});
			expect(res.status).toBe(400);
			expect(calls).toEqual([]);
		});

		test("accepts every canonical INBOX_PRIORITIES value", async () => {
			const runId = await createRunningRun();
			const calls: RecordedCall[] = [];
			const deps = await depsFor(repos, makePauseResumeClient(fix, calls));
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			});

			for (const priority of INBOX_PRIORITIES) {
				const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/steer`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ body: `at ${priority}`, priority }),
				});
				expect(res.status).toBe(200);
			}
			expect(calls.map((c) => (c.body as { priority?: string }).priority)).toEqual([
				...INBOX_PRIORITIES,
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
				sandboxRun: { id: string; state: string } | null;
			};
			expect(body.state).toBe("running");
			expect(body.alreadyTerminal).toBe(false);
			expect(body.sandboxRun?.id).toBe(fix.sandboxRunId);
			expect(body.sandboxRun?.state).toBe("running");
			// No reason key on the wire — `HttpRunsClient.cancel` omits the
			// jsonBody entirely when `opts.reason` is undefined. The graceful
			// cancel POST rides the seam; the status re-read follows it (warren-1f56).
			expect(calls).toContainEqual({
				method: "POST",
				path: `/runs/${fix.sandboxRunId}/cancel`,
				body: undefined,
			});
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
			expect(calls).toContainEqual({
				method: "POST",
				path: `/runs/${fix.sandboxRunId}/cancel`,
				body: { reason: "operator changed their mind" },
			});
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
				sandboxRun: unknown;
			};
			expect(body.state).toBe("succeeded");
			expect(body.alreadyTerminal).toBe(true);
			expect(body.sandboxRun).toBeNull();
			// `cancelRun` short-circuits on a terminal row — no wire call.
			expect(calls).toHaveLength(0);
		});
	});
});
