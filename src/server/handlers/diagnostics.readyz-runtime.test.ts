/**
 * `/readyz` runtime-topology scoping (warren-c128). The bwrap and
 * stale-burrow-workspace probes only make sense for the local backend, where
 * warren runs sandboxes in-process on the host. Under `WARREN_RUNTIME=k8s`
 * agents run in pods and bwrap lives in the agent image, so those probes must
 * be scoped out of readiness rather than reporting "bwrap not found" and
 * degrading an otherwise-healthy control plane. The burrow-daemon socket probe
 * died with the daemon (warren-9a26) — there is no `burrow_reachable` check on
 * either topology anymore.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Spawn stub that fails `bwrap --version` (host has no bubblewrap). */
const failBwrap: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) return { stdout: "", stderr: "not found", exitCode: 127 };
	return { stdout: "", stderr: "", exitCode: 0 };
};

async function readyzChecks(
	db: WarrenDb,
	k8sPodSync?: { isSynced(): boolean },
): Promise<{ status: number; names: string[]; ok: boolean }> {
	const repos = createRepos(db);
	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: { name: "refactor-bot", sections: { system: "x" } },
	});
	const deps = {
		repos,
		db,
		spawn: failBwrap,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(k8sPodSync !== undefined ? { k8sPodSync } : {}),
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

	test("local backend still weighs the bwrap probe (no bwrap ⇒ 503), with no burrow probe", async () => {
		process.env.WARREN_RUNTIME = "local";
		db = await openDatabase({ path: ":memory:" });
		const { status, names } = await readyzChecks(db);
		expect(status).toBe(503);
		expect(names).toContain("bwrap");
		expect(names).not.toContain("burrow_reachable");
	});

	test("k8s backend scopes local-sandbox probes out entirely (⇒ 200)", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, names } = await readyzChecks(db, { isSynced: () => true });
		expect(status).toBe(200);
		expect(ok).toBe(true);
		expect(names).not.toContain("burrow_reachable");
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("stale_sandbox_workspaces");
		// The topology-relevant checks survive.
		expect(names).toContain("db_reachable");
		expect(names).toContain("agents");
	});
});
