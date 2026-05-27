import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { type AnyWarrenDb, openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { isPostgresTestEnabled, withDb } from "../../db/testing.ts";
import { COOKIE_NAME, createPreviewAuth, type PreviewAuth } from "../../preview/cookie.ts";
import { createPreviewProxyHandler } from "../../preview/proxy/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { bearerAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

const TOKEN = "test-token-very-secret-1234567890abcdef";
const HOST = "preview.warren.example.com";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch,
	});
}

async function depsFor(
	repos: Repos,
	previewAuth: PreviewAuth | undefined,
	db?: AnyWarrenDb,
	previewMode: "subdomain" | "path" = "subdomain",
): Promise<{ deps: ServerDeps; bridges: BridgeRegistry }> {
	const client = makeBurrowClient();
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", client);
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		burrowClientPool,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	const previewExtras =
		previewAuth === undefined
			? {}
			: previewMode === "path"
				? { previewAuth, previewMode: "path" as const }
				: { previewAuth, previewMode: "subdomain" as const, previewHost: HOST };
	const deps: ServerDeps = {
		repos,
		burrowClientPool,
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(db !== undefined ? { db } : {}),
		...previewExtras,
	};
	return { deps, bridges };
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

/* Preview-surface tests for /runs/:id (extracted from handlers.preview.test.ts, warren-599c / pl-9088 step 3). */

describe("GET /runs/:id/preview/login", () => {
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
		});
		runId = run.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("issues a signed cookie and redirects to the run subdomain when token matches", async () => {
		const previewAuth = createPreviewAuth(TOKEN, {
			scope: { mode: "subdomain", cookieDomain: `.${HOST}` },
			secure: false,
		});
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(`https://run-${runId}.${HOST}/`);
		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain(`${COOKIE_NAME}=`);
		expect(setCookie).toContain(`Domain=.${HOST}`);
		expect(setCookie).toContain("HttpOnly");
	});

	test("401 when token is wrong (route auth-exempt, handler does its own check)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login?token=wrong`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unauthorized");
	});

	test("401 when token is missing", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);
	});

	test("404 when the runId is unknown (no cookie issued)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/run_unknown/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("400 when redirect points outside the run subdomain (no open redirect)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent("https://evil.example.com/")}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_redirect_invalid");
	});

	test("400 when redirect is http (not https)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent(`http://run-${runId}.${HOST}/`)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
	});

	test("400 when redirect targets a different run id", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
				TOKEN,
			)}&redirect=${encodeURIComponent(`https://run-otherrun.${HOST}/`)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
	});

	test("400-style validation when no preview surface configured", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ redirect: "manual" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	describe("path mode (warren-edff)", () => {
		test("302 with a Path=/p/<id>/ cookie and a same-origin redirect", async () => {
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(302);
			const origin = tcpUrl(handle);
			expect(res.headers.get("location")).toBe(`${origin}/p/${runId}/`);
			const setCookie = res.headers.get("set-cookie");
			// Path-mode cookie name carries the runId suffix (warren-63e1) and
			// is scoped Path=/ so the browser ships it on every same-origin
			// request — needed for referer-based asset routing.
			expect(setCookie).toContain(`${COOKIE_NAME}_${runId}=`);
			expect(setCookie).toContain("Path=/");
			expect(setCookie).not.toContain(`Path=/p/${runId}/`);
			expect(setCookie).not.toContain("Domain=");
		});

		test("accepts a relative redirect under /p/<id>/", async () => {
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
					TOKEN,
				)}&redirect=${encodeURIComponent(`/p/${runId}/inner`)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe(`${tcpUrl(handle)}/p/${runId}/inner`);
		});

		test("400 when redirect points outside /p/<id>/", async () => {
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
					TOKEN,
				)}&redirect=${encodeURIComponent("/agents")}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("preview_redirect_invalid");
		});

		test("400 when redirect targets a sibling run id", async () => {
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
					TOKEN,
				)}&redirect=${encodeURIComponent(`/p/run_otherrun/`)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(400);
		});

		test("400 when redirect is cross-origin", async () => {
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(
					TOKEN,
				)}&redirect=${encodeURIComponent(`https://evil.example.com/p/${runId}/`)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(400);
		});

		test("path mode works without WARREN_PREVIEW_HOST", async () => {
			// Regression for warren-edff: subdomain mode required previewHost
			// in deps and 400'd without it. Path mode must NOT require it.
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
			// Sanity: depsFor must NOT have wired previewHost.
			expect(deps.previewHost).toBeUndefined();
			handle = startServer(deps, {
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: bearerAuth(TOKEN),
				logger: silentLogger,
			});
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(302);
		});
	});
});

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
		// Build deps without db — the handler should refuse rather than
		// silently no-op against a missing CAS surface. The previous
		// sqlite-only gate (warren-a743) was dropped once createRunPreviewsRepo
		// became dialect-polymorphic; the only remaining precondition is the
		// repo layer existing at all.
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
	// Regression for warren-a743: handlers.ts previously hard-gated this
	// route on `dialect === "sqlite"` even though createRunPreviewsRepo
	// (the underlying CAS) was already pg-capable. Exercise the route end-
	// to-end against a real postgres to prove the gate is gone and the
	// happy path lights up the same `torn-down` outcome on pg.
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

describe("preview proxy preamble in startServer pipeline", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("proxy preamble runs BEFORE auth + route match", async () => {
		// Wire a stub previewProxy that always responds with a known body.
		// Without preview-preamble-before-auth, an unauthenticated `/agents`
		// request would 401; with it, the preamble's response wins. This is
		// what guarantees Host-based preview routing doesn't have to
		// satisfy the bearer-auth gate first.
		const { deps } = await depsFor(repos, undefined);
		const proxiedBody = JSON.stringify({ preempted: true });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
			previewProxy: async () =>
				new Response(proxiedBody, { status: 200, headers: { "content-type": "application/json" } }),
		});
		// No bearer header — the auth gate would normally 401 every API
		// surface, but the proxy preamble short-circuits.
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ preempted: true });
	});

	test("proxy preamble returning null falls through to the normal pipeline", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
			// "Not a preview request" → null → request continues to auth + router.
			previewProxy: async () => null,
		});
		const res = await fetch(`${tcpUrl(handle)}/agents`);
		expect(res.status).toBe(401);
	});

	test("proxy preamble can serve a live-preview unit-level forward without the auth gate", async () => {
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
			workerId: "local",
		});
		await repos.runs.attachPreview(run.id, {
			previewState: "live",
			previewPort: 30100,
			previewStartedAt: "2026-01-01T00:00:00Z",
			previewLastHitAt: "2026-01-01T00:00:00Z",
		});
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const proxy = createPreviewProxyHandler({
			repos,
			previewAuth,
			config: { mode: "subdomain", host: HOST },
			fetch: (async () => new Response("upstream-ok")) as unknown as typeof fetch,
		});
		const cookie = previewAuth.signCookie(run.id, new Date());
		// Direct unit-style invocation of the proxy handler — Host header
		// constructed inside the Request bypasses Bun.fetch's host-rewriting.
		const req = new Request(`http://run-${run.id}.${HOST}/`, {
			headers: {
				host: `run-${run.id}.${HOST}`,
				cookie: `${COOKIE_NAME}=${cookie.value}`,
			},
		});
		const url = new URL(req.url);
		const res = await proxy(req, url);
		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("upstream-ok");
	});
});
