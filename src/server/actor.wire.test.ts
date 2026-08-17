/**
 * End-to-end checks that the authorized `Actor` (warren-1ff0) reaches
 * route handlers on `RouteContext.actor`: present with its capability set
 * on every gated route regardless of which provider admitted the request,
 * absent on the auth-exempt paths where the gate never runs.
 *
 * No handler consults the actor yet — this is the seam test that keeps the
 * threading honest until the policy layer reads it. warren-851b extends it
 * to the public-read provider, whose anonymous actor is the first one that
 * reaches a handler holding less than everything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../runs/index.ts";
import { FakeProvider } from "../runtime/fake/fake-provider.ts";
import { ANONYMOUS_ACTOR, bearerAuth, NO_AUTH, OPERATOR_ACTOR, publicReadAuth } from "./auth.ts";
import { createBridgeRegistry } from "./bridges.ts";
import { startServer } from "./server.ts";
import type { Actor, Route, ServeHandle, ServerDeps } from "./types.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

async function depsFor(repos: Repos): Promise<ServerDeps> {
	const sandboxClient = new FakeProvider();
	const broker = new RunEventBroker();
	return {
		repos,
		runtimeProvider: sandboxClient,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: sandboxClient,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	};
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

/**
 * A route that records whatever actor (if any) the gate handed the handler.
 * `readPublic` so every actor below reaches it — the capability gate itself
 * is covered in `handlers/policy.wire.test.ts` (warren-b875).
 */
function capturingRoutes(pattern: string): {
	routes: Route[];
	seen: Array<Actor | undefined>;
} {
	const seen: Array<Actor | undefined> = [];
	const routes: Route[] = [
		{
			method: "GET",
			pattern,
			policy: "readPublic",
			handler: (ctx) => {
				seen.push(ctx.actor);
				return new Response("{}", { status: 200 });
			},
		},
	];
	return { routes, seen };
}

describe("RouteContext.actor wire integration (warren-1ff0)", () => {
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

	test("threads the operator actor onto a gated route under NO_AUTH", async () => {
		const { routes, seen } = capturingRoutes("/projects");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
			routes,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`);
		expect(res.status).toBe(200);
		expect(seen).toEqual([OPERATOR_ACTOR]);
	});

	test("threads the operator actor onto a gated route under bearerAuth", async () => {
		const { routes, seen } = capturingRoutes("/projects");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("secret"),
			logger: silentLogger,
			routes,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(res.status).toBe(200);
		expect(seen[0]?.capabilities).toEqual({
			readPublic: true,
			readOperator: true,
			dispatch: true,
			admin: true,
		});
	});

	test("a denied request never reaches a handler, so no actor is minted", async () => {
		const { routes, seen } = capturingRoutes("/projects");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("secret"),
			logger: silentLogger,
			routes,
		});
		const res = await fetch(`${tcpUrl(handle)}/projects`, {
			headers: { authorization: "Bearer wrong" },
		});
		expect(res.status).toBe(401);
		expect(seen).toEqual([]);
	});

	test("threads the anonymous actor onto a gated route under publicReadAuth", async () => {
		const { routes, seen } = capturingRoutes("/projects");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth("secret")),
			logger: silentLogger,
			routes,
		});
		const anon = await fetch(`${tcpUrl(handle)}/projects`);
		expect(anon.status).toBe(200);
		const operator = await fetch(`${tcpUrl(handle)}/projects`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(operator.status).toBe(200);
		expect(seen).toEqual([ANONYMOUS_ACTOR, OPERATOR_ACTOR]);
	});

	test("leaves the actor undefined on auth-exempt paths", async () => {
		const { routes, seen } = capturingRoutes("/healthz");
		handle = startServer(await depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("secret"),
			logger: silentLogger,
			routes,
		});
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		expect(res.status).toBe(200);
		expect(seen).toEqual([undefined]);
	});
});
