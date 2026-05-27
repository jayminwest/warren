import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { type AnyWarrenDb, openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../../preview/cookie.ts";
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

/* GET /preview/config tests (extracted from handlers.preview.test.ts, warren-599c / pl-9088 step 3). */

describe("GET /preview/config (warren-016d)", () => {
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

	test("returns mode + host in subdomain mode", async () => {
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
		const res = await fetch(`${tcpUrl(handle)}/preview/config`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { mode: string; host: string | null };
		expect(body.mode).toBe("subdomain");
		expect(body.host).toBe(HOST);
	});

	test("returns mode + null host in path mode without WARREN_PREVIEW_HOST", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { scope: { mode: "path" }, secure: false });
		const { deps } = await depsFor(repos, previewAuth, undefined, "path");
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/preview/config`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { mode: string; host: string | null };
		expect(body.mode).toBe("path");
		expect(body.host).toBeNull();
	});

	test("401 without a bearer token (gated like every non-login preview surface)", async () => {
		const previewAuth = createPreviewAuth(TOKEN, { scope: { mode: "path" }, secure: false });
		const { deps } = await depsFor(repos, previewAuth, undefined, "path");
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/preview/config`);
		expect(res.status).toBe(401);
	});
});
