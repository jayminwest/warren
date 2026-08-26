/**
 * Wire-level tests for `GET /instance` (warren-2eec / pl-7e38 step 17).
 *
 * The endpoint is a read-only facts surface: operator callers get the full
 * boot facts, `WARREN_AUTH=public` spectators get the reduced static
 * projection, and neither body may ever contain a secret, token,
 * connection string, or filesystem path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { AuthProvider, ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "operator-secret-token-abcdef";

interface InstanceBody {
	version: string;
	runtime: string;
	authMode: string;
	dbBackend?: string | null;
	uptimeSeconds?: number;
	admission?: {
		maxQueueDepth: number;
		maxPendingPods: number;
		maxProjectConcurrency: number | null;
	} | null;
}

const SECRET_MARKERS = [
	TOKEN,
	"postgres://",
	"sqlite:",
	"WARREN_DB_URL",
	"WARREN_API_TOKEN",
	"localhost",
	"/workspace",
	"/tmp",
	"password",
];

/** An operator body must never carry any secret-shaped substring. */
function expectNoSecrets(body: unknown): void {
	const text = JSON.stringify(body);
	for (const marker of SECRET_MARKERS) {
		expect(text.includes(marker)).toBe(false);
	}
}

describe("GET /instance", () => {
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

	async function serve(auth: AuthProvider): Promise<string> {
		const deps = await depsFor(repos, new FakeProvider());
		handle = startServer(
			{ ...deps, db },
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth,
				logger: silentLogger,
			},
		);
		return tcpUrl(handle);
	}

	test("returns full boot facts to the operator", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const res = await fetch(`${base}/instance`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as InstanceBody;
		expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(body.runtime).toBe("local");
		expect(body.authMode).toBe("token");
		expect(body.dbBackend).toBe("sqlite");
		expect(typeof body.uptimeSeconds).toBe("number");
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
		// Local runtime: admission caps are K8s-only knobs, so they stay null.
		expect(body.admission).toBeNull();
		expectNoSecrets(body);
	});

	test("reduces to the static projection for a public spectator", async () => {
		// Boot resolves the auth backend from the same env the handler reads,
		// so mirror a `WARREN_AUTH=public` boot here (restored in afterEach).
		process.env.WARREN_AUTH = "public";
		try {
			const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
			const res = await fetch(`${base}/instance`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as InstanceBody;
			// Allowlist projection: only the three static facts.
			expect(Object.keys(body).sort()).toEqual(["authMode", "runtime", "version"]);
			expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(body.authMode).toBe("public");
			expectNoSecrets(body);
		} finally {
			delete process.env.WARREN_AUTH;
		}
	});

	test("an operator still gets the full body under public auth", async () => {
		process.env.WARREN_AUTH = "public";
		try {
			const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
			const res = await fetch(`${base}/instance`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as InstanceBody;
			expect(body.dbBackend).toBe("sqlite");
			expect(body.authMode).toBe("public");
			expectNoSecrets(body);
		} finally {
			delete process.env.WARREN_AUTH;
		}
	});

	test("refuses a credential-less caller under token auth", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const res = await fetch(`${base}/instance`);
		expect(res.status).toBe(401);
	});

	test("body varies with Authorization", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const res = await fetch(`${base}/instance`);
		expect(res.headers.get("vary")).toBe("Authorization");
	});
});
