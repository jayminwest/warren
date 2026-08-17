import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { API_ROUTE_POLICIES } from "./index.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * Wire-level proof that the route policy table (warren-b875) is actually
 * enforced, route by route, against a real server under
 * `WARREN_AUTH=public`.
 *
 * The classification itself (which route is public, which is operator-only)
 * is asserted as data in `index.test.ts`; this file drives every entry over
 * HTTP and asserts the gate refuses the ones it should — including the
 * mutations, which is the "minus dispatch" half of the public-instance
 * product scope.
 */

const TOKEN = "s3cret";

/** A burrow client that 404s everything — no gated route here reaches it. */
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

/** Substitute a placeholder for each `:param` so the pattern is a real path. */
function concretePath(pattern: string): string {
	return pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "placeholder");
}

describe("route policy enforcement under WARREN_AUTH=public (warren-b875)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		handle = startServer(await depsFor(repos, inertSandboxClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	/** Anonymous request against a route pattern, params filled in. */
	async function callAnonymously(method: string, pattern: string): Promise<Response> {
		return fetch(`${base}${concretePath(pattern)}`, {
			method,
			...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }),
		});
	}

	const blocked = API_ROUTE_POLICIES.filter(
		(r) => r.policy !== "anonymous" && r.policy !== "readPublic",
	);
	const spectator = API_ROUTE_POLICIES.filter(
		(r) => r.policy === "anonymous" || r.policy === "readPublic",
	);

	for (const route of blocked) {
		test(`${route.method} ${route.pattern} → 403 for an anonymous caller`, async () => {
			const res = await callAnonymously(route.method, route.pattern);
			expect(res.status).toBe(403);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("forbidden");
			expect(body.error.message).toContain(route.policy);
		});
	}

	for (const route of spectator) {
		test(`${route.method} ${route.pattern} is reachable by an anonymous caller`, async () => {
			const res = await callAnonymously(route.method, route.pattern);
			// The handler runs — what it answers (200, or 404 for the
			// placeholder id) is that handler's business; the gate must not be
			// what stops it.
			expect(res.status).not.toBe(403);
			expect(res.status).not.toBe(401);
			await res.body?.cancel();
		});
	}

	test("the operator still reaches every blocked route (no capability regression)", async () => {
		for (const route of blocked) {
			const res = await fetch(`${base}${concretePath(route.pattern)}`, {
				method: route.method,
				headers: {
					authorization: `Bearer ${TOKEN}`,
					...(route.method === "GET" ? {} : { "content-type": "application/json" }),
				},
				...(route.method === "GET" ? {} : { body: "{}" }),
			});
			expect({ route: `${route.method} ${route.pattern}`, forbidden: res.status === 403 }).toEqual({
				route: `${route.method} ${route.pattern}`,
				forbidden: false,
			});
			await res.body?.cancel();
		}
	});

	test("a bad bearer is still a 401, never a degraded public read", async () => {
		const res = await fetch(`${base}/runs`, { headers: { authorization: "Bearer wrong" } });
		expect(res.status).toBe(401);
	});

	test("the refusal is logged as server.policy_denied with the demanded policy", async () => {
		const events: { msg: string; obj: Record<string, unknown> }[] = [];
		const logger = {
			info() {},
			error() {},
			warn(obj: Record<string, unknown>, msg: string) {
				events.push({ obj, msg });
			},
		};
		if (handle) await handle.stop();
		handle = startServer(await depsFor(repos, inertSandboxClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger,
		});
		const res = await fetch(`${tcpUrl(handle)}/metrics`);
		expect(res.status).toBe(403);
		expect(events.find((e) => e.msg === "server.policy_denied")?.obj).toMatchObject({
			path: "/metrics",
			status: 403,
			code: "forbidden",
			policy: "readOperator",
		});
	});
});

describe("route policy enforcement under the default token provider", () => {
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

	test("the operator's full capability set clears every policy (fresh-install path)", async () => {
		handle = startServer(await depsFor(repos, inertSandboxClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth(TOKEN),
			logger: silentLogger,
		});
		const base = tcpUrl(handle);
		for (const route of API_ROUTE_POLICIES) {
			const res = await fetch(`${base}${concretePath(route.pattern)}`, {
				method: route.method,
				headers: {
					authorization: `Bearer ${TOKEN}`,
					...(route.method === "GET" ? {} : { "content-type": "application/json" }),
				},
				...(route.method === "GET" ? {} : { body: "{}" }),
			});
			expect({ route: `${route.method} ${route.pattern}`, status: res.status === 403 }).toEqual({
				route: `${route.method} ${route.pattern}`,
				status: false,
			});
			await res.body?.cancel();
		}
	});
});
