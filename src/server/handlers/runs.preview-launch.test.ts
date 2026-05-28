import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth } from "../../preview/cookie.ts";
import { bearerAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, HOST, silentLogger, TOKEN, tcpUrl } from "./runs.preview-test-helpers.ts";

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
			const previewAuth = createPreviewAuth(TOKEN, {
				scope: { mode: "path" },
				secure: false,
			});
			const { deps } = await depsFor(repos, previewAuth, undefined, "path");
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
