/**
 * Pre-auth leak tests for the preview proxy preamble (warren-820e).
 *
 * The proxy runs BEFORE warren's auth gate, so every unauthenticated
 * answer is public surface. These tests pin two invariants:
 *
 *   1. **No run-existence oracle.** An unknown run id and an existing
 *      but previewless run id must be indistinguishable to an
 *      unauthenticated caller (same status, same envelope code).
 *
 *   2. **No internal identifier echo.** No pre-auth (or post-auth
 *      error) response may leak `worker_id` values — a
 *      REDACTED_RUN_FIELDS member (warren-946f) — or other internal
 *      run shape beyond the caller-supplied runId.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { LOCAL_WORKER_NAME } from "../../runs/worker-identity.ts";
import type { PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, setupProxyEnv } from "./test-helpers.ts";

const REMOTE_WORKER_SENTINEL = "worker-sentinel-9f3c-internal";

describe("preview proxy pre-auth leak guard (warren-820e)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;
	let projectId: string;
	/** A run that exists in the runs table but never got a preview. */
	let previewlessRunId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId, projectId } = await setupProxyEnv({
			scope: "path",
			previewPort: 30200,
		}));
		const previewless = await repos.runs.create({
			agentName: "agent",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			workerId: LOCAL_WORKER_NAME,
		});
		previewlessRunId = previewless.id;
	});

	afterEach(async () => {
		await db.close();
	});

	function unauthenticatedPathRequest(targetRunId: string): {
		request: Request;
		url: URL;
	} {
		const request = new Request(`http://warren.example.com/p/${targetRunId}/`, {
			headers: { host: "warren.example.com" },
		});
		return { request, url: new URL(request.url) };
	}

	test("unknown run id and existing-but-previewless run id are indistinguishable without a cookie", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const probe = async (targetRunId: string) => {
			const { request, url } = unauthenticatedPathRequest(targetRunId);
			return handler(request, url);
		};
		const unknown = await probe("run_never_existed");
		const previewless = await probe(previewlessRunId);
		expect(unknown?.status).toBe(401);
		expect(previewless?.status).toBe(401);
		const unknownBody = (await unknown?.json()) as { error: { code: string } };
		const previewlessBody = (await previewless?.json()) as { error: { code: string } };
		expect(unknownBody.error.code).toBe("preview_unauthorized");
		expect(previewlessBody.error.code).toBe(unknownBody.error.code);
	});

	test("remote-worker run is indistinguishable without a cookie and leaks no worker id", async () => {
		await repos.runs.attachBurrow(runId, { workerId: REMOTE_WORKER_SENTINEL });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = unauthenticatedPathRequest(runId);
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		const text = await res?.text();
		expect(text).not.toContain(REMOTE_WORKER_SENTINEL);
		expect(text?.toLowerCase()).not.toContain("worker");
	});

	test("referer-routed asset probing for an unknown run id returns the same 401 as a live run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const probe = async (targetRunId: string) => {
			const request = new Request("http://warren.example.com/_next/static/app.js", {
				headers: {
					host: "warren.example.com",
					referer: `http://warren.example.com/p/${targetRunId}/`,
				},
			});
			return handler(request, new URL(request.url));
		};
		const unknown = await probe("run_never_existed");
		const live = await probe(runId);
		expect(unknown?.status).toBe(401);
		expect(live?.status).toBe(401);
		const unknownBody = (await unknown?.json()) as { error: { code: string } };
		const liveBody = (await live?.json()) as { error: { code: string } };
		expect(unknownBody.error.code).toBe(liveBody.error.code);
	});

	test("cookie-verified remote-worker 501 still never echoes the worker id", async () => {
		await repos.runs.attachBurrow(runId, { workerId: REMOTE_WORKER_SENTINEL });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const cookie = auth.signCookie(runId, new Date());
		const request = new Request(`http://warren.example.com/p/${runId}/`, {
			headers: {
				host: "warren.example.com",
				cookie: `${cookie.name}=${cookie.value}`,
			},
		});
		const res = await handler(request, new URL(request.url));
		expect(res?.status).toBe(501);
		const text = await res?.text();
		expect(text).not.toContain(REMOTE_WORKER_SENTINEL);
		expect(text?.toLowerCase()).not.toContain("worker_id");
	});
});
