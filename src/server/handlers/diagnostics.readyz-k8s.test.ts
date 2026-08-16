/**
 * `/readyz` `k8s_api_reachable` check (warren-39e1). Under
 * `WARREN_RUNTIME=k8s` the burrow probes are scoped out (warren-c128), so
 * readiness asserts something POSITIVE about the K8s control plane instead:
 * the pod-watcher informer's `isSynced()` seam. Synced watcher ⇒ the check
 * passes; unsynced / unwired watcher ⇒ `/readyz` is non-ready with the
 * `k8s_api_reachable` check failed. Under `local` the check is absent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { PodSyncSource } from "../../runtime/k8s/pod-watcher.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

interface ReadyzResult {
	status: number;
	ok: boolean;
	checks: { name: string; ok: boolean; message?: string }[];
}

async function readyz(db: WarrenDb, k8sPodSync?: PodSyncSource): Promise<ReadyzResult> {
	const repos = createRepos(db);
	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: { name: "refactor-bot", sections: { system: "x" } },
	});
	const deps = {
		repos,
		db,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(k8sPodSync !== undefined ? { k8sPodSync } : {}),
	} as unknown as ServerDeps;
	const res = await readyzHandler(deps)({} as RouteContext);
	const body = (await res.json()) as { ok: boolean; checks: ReadyzResult["checks"] };
	return { status: res.status, ok: body.ok, checks: body.checks };
}

describe("/readyz k8s_api_reachable (warren-39e1)", () => {
	const prev = process.env.WARREN_RUNTIME;
	let db: WarrenDb | null = null;

	afterEach(async () => {
		if (prev === undefined) delete process.env.WARREN_RUNTIME;
		else process.env.WARREN_RUNTIME = prev;
		await db?.close();
		db = null;
	});

	test("k8s + synced watcher ⇒ k8s_api_reachable passes (⇒ 200)", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, checks } = await readyz(db, { isSynced: () => true });
		expect(status).toBe(200);
		expect(ok).toBe(true);
		const check = checks.find((c) => c.name === "k8s_api_reachable");
		expect(check?.ok).toBe(true);
	});

	test("k8s + unsynced watcher ⇒ non-ready with k8s_api_reachable failed", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, checks } = await readyz(db, { isSynced: () => false });
		expect(status).toBe(503);
		expect(ok).toBe(false);
		const check = checks.find((c) => c.name === "k8s_api_reachable");
		expect(check?.ok).toBe(false);
		expect(check?.message).toContain("not synced");
	});

	test("k8s + no watcher wired ⇒ non-ready with k8s_api_reachable failed", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, checks } = await readyz(db);
		expect(status).toBe(503);
		expect(ok).toBe(false);
		const check = checks.find((c) => c.name === "k8s_api_reachable");
		expect(check?.ok).toBe(false);
		expect(check?.message).toContain("not wired");
	});

	test("local topology ⇒ k8s_api_reachable absent from the payload", async () => {
		process.env.WARREN_RUNTIME = "local";
		db = await openDatabase({ path: ":memory:" });
		const { checks } = await readyz(db, { isSynced: () => true });
		expect(checks.map((c) => c.name)).not.toContain("k8s_api_reachable");
	});
});
