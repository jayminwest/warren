import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { COOKIE_NAME, createPreviewAuth } from "../../preview/cookie.ts";
import { bearerAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, HOST, silentLogger, TOKEN, tcpUrl } from "./runs.preview-test-helpers.ts";

/**
 * `POST /runs/:id/preview/login` (warren-e1b0). The handshake used to be
 * `GET …?token=<bearer>` on an auth-exempt route; the bearer now rides the
 * `Authorization` header through the standard gate and the target comes
 * back as a JSON `url` instead of a `Location` header.
 */

/** POST the handshake with the bearer in the header, like the UI does. */
function login(
	handle: ServeHandle,
	runId: string,
	body: Record<string, unknown> = {},
	token: string = TOKEN,
): Promise<Response> {
	return fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		redirect: "manual",
	});
}

describe("POST /runs/:id/preview/login", () => {
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

	test("issues a signed cookie and returns the run subdomain URL when the bearer matches", async () => {
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
		const res = await login(handle, runId);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { url: string };
		expect(body.url).toBe(`https://run-${runId}.${HOST}/`);
		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain(`${COOKIE_NAME}=`);
		expect(setCookie).toContain(`Domain=.${HOST}`);
		expect(setCookie).toContain("HttpOnly");
	});

	test("the returned URL carries no token-shaped query value (warren-e1b0)", async () => {
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
		const res = await login(handle, runId);
		const { url } = (await res.json()) as { url: string };
		expect(new URL(url).search).toBe("");
		expect(url).not.toContain(TOKEN);
		// The credential lives in the cookie, never in a location header.
		expect(res.headers.get("location")).toBeNull();
	});

	test("401 when the bearer is wrong (standard gate, no route exemption)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await login(handle, runId, {}, "wrong");
		expect(res.status).toBe(401);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("401 when the bearer is missing", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/runs/${runId}/preview/login`, {
			method: "POST",
			redirect: "manual",
		});
		expect(res.status).toBe(401);
	});

	test("a token in the query string is not accepted as a credential", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/runs/${runId}/preview/login?token=${encodeURIComponent(TOKEN)}`,
			{ method: "POST", redirect: "manual" },
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("404 when the runId is unknown (no cookie issued)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { secure: false });
		const { deps } = await depsFor(repos, previewAuth);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await login(handle, "run_unknown");
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
		const res = await login(handle, runId, { redirect: "https://evil.example.com/" });
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
		const res = await login(handle, runId, { redirect: `http://run-${runId}.${HOST}/` });
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
		const res = await login(handle, runId, { redirect: `https://run-otherrun.${HOST}/` });
		expect(res.status).toBe(400);
	});

	test("400-style validation when no preview surface configured", async () => {
		const { deps } = await depsFor(repos, undefined);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await login(handle, runId);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	describe("path mode (warren-edff)", () => {
		test("200 with a Path=/ per-run cookie and a same-origin URL", async () => {
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
			const res = await login(handle, runId);
			expect(res.status).toBe(200);
			const origin = tcpUrl(handle);
			const body = (await res.json()) as { url: string };
			expect(body.url).toBe(`${origin}/p/${runId}/`);
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
			const res = await login(handle, runId, { redirect: `/p/${runId}/inner` });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { url: string };
			expect(body.url).toBe(`${tcpUrl(handle)}/p/${runId}/inner`);
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
			const res = await login(handle, runId, { redirect: "/agents" });
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
			const res = await login(handle, runId, { redirect: "/p/run_otherrun/" });
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
			const res = await login(handle, runId, {
				redirect: `https://evil.example.com/p/${runId}/`,
			});
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
			const res = await login(handle, runId);
			expect(res.status).toBe(200);
		});
	});
});
