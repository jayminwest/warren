import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AnyWarrenDb, openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { isPostgresTestEnabled, withDb } from "../../db/testing.ts";
import { bearerAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, TOKEN, tcpUrl } from "./runs.preview-test-helpers.ts";

describe("POST /runs/:id/preview/teardown", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_teardown",
		});
		runId = run.id;
		await repos.runs.attachPreview(run.id, {
			previewState: "live",
			previewPort: 30200,
			previewStartedAt: "2026-05-14T18:00:00.000Z",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("200 + flips live → torn-down, releases port, emits preview_torn_down event", async () => {
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			tornDown: boolean;
			previousState: string | null;
			port: number | null;
		};
		expect(body).toEqual({
			status: "torn-down",
			tornDown: true,
			previousState: "live",
			port: 30200,
		});

		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
		expect(reread.previewPort).toBeNull();

		const events = await repos.events.listByRun(runId);
		const evt = events.find((e) => e.kind === "preview_torn_down");
		expect(evt).toBeDefined();
		expect(evt?.payloadJson).toEqual({
			actor: "manual",
			port: 30200,
			previousState: "live",
		});
	});

	test("forwards body.actor onto the audit event", async () => {
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ actor: "ui-user-jayminwest" }),
		});
		expect(res.status).toBe(200);

		const events = await repos.events.listByRun(runId);
		const evt = events.find((e) => e.kind === "preview_torn_down");
		expect(evt?.payloadJson).toMatchObject({ actor: "ui-user-jayminwest" });
	});

	test("idempotent: a second POST returns 200 with tornDown=false and no second event", async () => {
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const first = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(first.status).toBe(200);

		const second = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(second.status).toBe(200);
		const body = (await second.json()) as { status: string; tornDown: boolean };
		expect(body.status).toBe("already-torn-down");
		expect(body.tornDown).toBe(false);

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === "preview_torn_down")).toHaveLength(1);
	});

	test("401 without a bearer token (route is bearer-gated, not auth-exempt)", async () => {
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	test("404 when the runId is unknown", async () => {
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/run_missing/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(404);
	});

	test("`never-launched` for a run that never opted in", async () => {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y2.git",
			localPath: "/data/projects/x/y2",
			defaultBranch: "main",
		});
		const noPreview = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${noPreview.id}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; tornDown: boolean };
		expect(body.status).toBe("never-launched");
		expect(body.tornDown).toBe(false);
	});

	test("503 when no db handle is wired", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_teardown_unavailable");
	});
});

describe.skipIf(!isPostgresTestEnabled())("POST /runs/:id/preview/teardown (postgres)", () => {
	let db: AnyWarrenDb;
	let close: () => Promise<void>;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let runId: string;

	beforeEach(async () => {
		const opened = await withDb({ dialect: "postgres" });
		db = opened.db;
		close = opened.close;
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_teardown_pg",
		});
		runId = run.id;
		await repos.runs.attachPreview(run.id, {
			previewState: "live",
			previewPort: 30201,
			previewStartedAt: "2026-05-14T18:00:00.000Z",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await close();
	});

	test("200 + flips live → torn-down on postgres dialect", async () => {
		expect(db.dialect).toBe("postgres");
		const { deps } = await depsFor(repos, undefined, db);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/teardown`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			tornDown: boolean;
			previousState: string | null;
			port: number | null;
		};
		expect(body).toEqual({
			status: "torn-down",
			tornDown: true,
			previousState: "live",
			port: 30201,
		});

		const reread = await repos.runs.require(runId);
		expect(reread.previewState).toBe("torn-down");
		expect(reread.previewPort).toBeNull();
	});
});
