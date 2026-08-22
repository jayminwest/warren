/**
 * HTTP coverage for `POST /runs/:id/git-credential` (warren-c9ac,
 * forge-contract.md §4.1 window 3): the in-pod harness re-mints a push
 * credential over the authenticated callback when no reap intent parked one.
 * The handler resolves run → project → `mintGitCredential(deps.forge)`;
 * FakeForge (depsFor's default) mints `fake-credential`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("POST /runs/:id/git-credential (warren-c9ac)", () => {
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

	async function serve(): Promise<string> {
		const deps = await depsFor(repos, inertSandboxClient());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	async function createRun(id = "run_x"): Promise<string> {
		const project = await repos.projects.create({
			gitUrl: "fake://acme/widgets", // the FakeForge-owned scheme (its parseRepoRef)
			localPath: "/tmp/widgets",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			id,
			agentName: "claude-code",
			projectId: project.id,
			renderedAgentJson: {},
			prompt: "fix",
			trigger: "test",
		});
		return run.id;
	}

	test("mints a fresh credential off the forge for the run's project", async () => {
		const runId = await createRun();
		const base = await serve();
		const res = await fetch(`${base}/runs/${runId}/git-credential`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ gitToken: "fake-credential" });
	});

	test("404s on an unknown run", async () => {
		const base = await serve();
		const res = await fetch(`${base}/runs/run_nope/git-credential`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});
