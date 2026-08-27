/**
 * End-to-end proof of the run-scoped callback credential (warren-57fd).
 *
 * Drives a real `startServer` pipeline (auth gate + capability gate + run-scope
 * narrowing) with `runScopedAuth` wired exactly as `resolveAuth` wires it, and
 * asserts the acceptance criteria from the issue: a token captured from inside
 * a run pod cannot dispatch a run, delete a project, or read any operator-only
 * body — it may reach ONLY its own run's callback surface, and only while the
 * run is live.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmacRunTokenMinter } from "../runs/spawn/run-token.ts";
import { bearerAuth, runScopedAuth } from "./auth.ts";
import { startServer } from "./server.ts";
import type { Route, ServeHandle, ServerDeps } from "./types.ts";

const SECRET = "tok_operator_secret";
const RUN_A = "run_aaaaaaaaaaaa";
const RUN_B = "run_bbbbbbbbbbbb";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const ok: Route["handler"] = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

const routes: Route[] = [
	{ method: "GET", pattern: "/runs/:id/inbox", policy: "readOperator", handler: ok },
	{ method: "GET", pattern: "/runs/:id/finalize-intent", policy: "readOperator", handler: ok },
	{ method: "POST", pattern: "/runs/:id/finalize-result", policy: "dispatch", handler: ok },
	{ method: "POST", pattern: "/runs/:id/git-credential", policy: "dispatch", handler: ok },
	{ method: "POST", pattern: "/runs", policy: "dispatch", handler: ok },
	{ method: "DELETE", pattern: "/projects/:id", policy: "admin", handler: ok },
	{ method: "GET", pattern: "/analytics/cost", policy: "readOperator", handler: ok },
];

// Only RUN_A is live; any other run id reads as terminal.
const runActivityCheck = async (runId: string) => runId === RUN_A;

const deps = { logger: silentLogger, uiDistDir: null } as unknown as ServerDeps;

let handle: ServeHandle;
let base: string;
const scopedA = createHmacRunTokenMinter(SECRET).mint(RUN_A);

beforeEach(() => {
	handle = startServer(deps, {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: runScopedAuth(bearerAuth(SECRET), SECRET),
		logger: silentLogger,
		routes,
		runActivityCheck,
	});
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp");
	base = `http://${handle.transport.hostname}:${handle.transport.port}`;
});
afterEach(async () => {
	await handle.stop();
});

function call(method: string, path: string, token: string): Promise<Response> {
	return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

describe("run-scoped token — accepted on its own callback surface", () => {
	test("GET /runs/:id/inbox for its own run", async () => {
		expect((await call("GET", `/runs/${RUN_A}/inbox`, scopedA)).status).toBe(200);
	});

	test("GET /runs/:id/finalize-intent for its own run", async () => {
		expect((await call("GET", `/runs/${RUN_A}/finalize-intent`, scopedA)).status).toBe(200);
	});

	test("POST /runs/:id/finalize-result for its own run", async () => {
		expect((await call("POST", `/runs/${RUN_A}/finalize-result`, scopedA)).status).toBe(200);
	});

	// warren-5a5c: the K8s App-mode credential remint rides the same
	// run-scoped channel — the pod's finalize-entrypoint POSTs here with
	// `WARREN_API_TOKEN` set to the run-scoped credential.
	test("POST /runs/:id/git-credential for its own run", async () => {
		expect((await call("POST", `/runs/${RUN_A}/git-credential`, scopedA)).status).toBe(200);
	});
});

describe("run-scoped token — rejected on operator routes (acceptance)", () => {
	test("cannot dispatch a run", async () => {
		expect((await call("POST", "/runs", scopedA)).status).toBe(403);
	});

	test("cannot delete a project", async () => {
		expect((await call("DELETE", "/projects/prj_xxxxxxxxxxxx", scopedA)).status).toBe(403);
	});

	test("cannot read an operator-only body", async () => {
		expect((await call("GET", "/analytics/cost", scopedA)).status).toBe(403);
	});

	test("cannot reach another run's callback surface", async () => {
		expect((await call("GET", `/runs/${RUN_B}/inbox`, scopedA)).status).toBe(403);
		expect((await call("POST", `/runs/${RUN_B}/finalize-result`, scopedA)).status).toBe(403);
		expect((await call("POST", `/runs/${RUN_B}/git-credential`, scopedA)).status).toBe(403);
	});
});

describe("run-scoped token — bounded by run lifetime", () => {
	test("rejected once the run is terminal", async () => {
		const scopedB = createHmacRunTokenMinter(SECRET).mint(RUN_B);
		// RUN_B reads terminal (runActivityCheck returns false) → 401 on its own inbox.
		expect((await call("GET", `/runs/${RUN_B}/inbox`, scopedB)).status).toBe(401);
	});
});

describe("operator token — unaffected", () => {
	test("still reaches every route", async () => {
		expect((await call("POST", "/runs", SECRET)).status).toBe(200);
		expect((await call("DELETE", "/projects/prj_xxxxxxxxxxxx", SECRET)).status).toBe(200);
		expect((await call("GET", "/analytics/cost", SECRET)).status).toBe(200);
		expect((await call("GET", `/runs/${RUN_A}/inbox`, SECRET)).status).toBe(200);
	});
});

describe("forged / tampered run token", () => {
	test("a bad-signature run token is 401", async () => {
		expect((await call("GET", `/runs/${RUN_A}/inbox`, `wrs1.${RUN_A}.deadbeef`)).status).toBe(401);
	});
});
