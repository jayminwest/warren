/**
 * `/readyz` runtime-topology scoping (warren-c128). The burrow socket, bwrap,
 * and stale-burrow-workspace probes only make sense for the local backend. Under
 * `WARREN_RUNTIME=k8s` there is no co-tenanted burrow daemon, so those probes
 * must be scoped out of readiness rather than reporting "burrow unreachable" and
 * degrading an otherwise-healthy control plane.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { checkBurrowPoolReachable } from "../../runtime/local/diagnostics/burrow.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A burrow client whose `/healthz` probe fails — as if no daemon is running. */
function unreachableBurrow(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/nope.sock" } },
		fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
	});
}

/** Spawn stub that fails `bwrap --version` (host has no bubblewrap). */
const failBwrap: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) return { stdout: "", stderr: "not found", exitCode: 127 };
	return { stdout: "", stderr: "", exitCode: 0 };
};

async function readyzChecks(
	db: WarrenDb,
): Promise<{ status: number; names: string[]; ok: boolean }> {
	const repos = createRepos(db);
	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: { name: "refactor-bot", sections: { system: "x" } },
	});
	const deps = {
		repos,
		db,
		// warren-f796: the burrow probe is a boot-wired thunk on ServerDeps, not a
		// live client. Mirror the LocalBootBackend by probing an unreachable client.
		burrowProbe: () => checkBurrowPoolReachable(unreachableBurrow()),
		spawn: failBwrap,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
	} as unknown as ServerDeps;
	const res = await readyzHandler(deps)({} as RouteContext);
	const body = (await res.json()) as { ok: boolean; checks: { name: string }[] };
	return { status: res.status, ok: body.ok, names: body.checks.map((c) => c.name) };
}

describe("/readyz runtime-topology scoping (warren-c128)", () => {
	const prev = process.env.WARREN_RUNTIME;
	let db: WarrenDb | null = null;

	afterEach(async () => {
		if (prev === undefined) delete process.env.WARREN_RUNTIME;
		else process.env.WARREN_RUNTIME = prev;
		await db?.close();
		db = null;
	});

	test("local backend still weighs the burrow probes (unreachable burrow ⇒ 503)", async () => {
		process.env.WARREN_RUNTIME = "local";
		db = await openDatabase({ path: ":memory:" });
		const { status, names } = await readyzChecks(db);
		expect(status).toBe(503);
		expect(names).toContain("burrow_reachable");
		expect(names).toContain("bwrap");
	});

	test("k8s backend scopes burrow probes out entirely (⇒ 200)", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, names } = await readyzChecks(db);
		expect(status).toBe(200);
		expect(ok).toBe(true);
		expect(names).not.toContain("burrow_reachable");
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("stale_burrow_workspaces");
		// The topology-relevant checks survive.
		expect(names).toContain("db_reachable");
		expect(names).toContain("agents");
	});
});
