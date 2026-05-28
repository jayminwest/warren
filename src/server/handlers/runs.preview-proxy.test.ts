import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth } from "../../preview/cookie.ts";
import { createPreviewProxyHandler } from "../../preview/proxy/index.ts";
import { bearerAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, HOST, silentLogger, TOKEN, tcpUrl } from "./runs.preview-test-helpers.ts";

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
