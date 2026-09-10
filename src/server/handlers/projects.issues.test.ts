import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { IssueListingTracker, IssueTracker } from "../../tracker/contract.ts";
import { ProjectTracker } from "../../tracker/project-tracker.ts";
import { RemoteTracker } from "../../tracker/remote/remote-tracker.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { bearerAuth, NO_AUTH, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { AuthProvider, ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

describe("project issue queue", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | undefined;
	let dir: string;
	let projectId: string;
	let issue: Issue;
	let calls: { method: string; path: string; body: unknown }[];

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		dir = mkdtempSync(join(tmpdir(), "warren-issue-queue-"));
		const project = await repos.projects.create({
			gitUrl: "https://github.com/acme/web.git",
			localPath: dir,
			defaultBranch: "main",
			hasSeeds: false,
		});
		projectId = project.id;
		await repos.agents.upsert({
			name: "test-agent",
			renderedJson: {
				name: "test-agent",
				version: 1,
				sections: { system: "Implement the task" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		issue = {
			id: "acme/web#1",
			status: "open",
			ready: true,
			title: "Fix navigation",
			description: "No overflow at 375px",
			repositoryUrl: "https://github.com/acme/web",
			url: "https://github.com/acme/web/issues/1",
		};
		calls = [];
	});
	afterEach(async () => {
		if (handle) await handle.stop();
		handle = undefined;
		await db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function boot(override?: IssueTracker, auth: AuthProvider = NO_AUTH) {
		const tracker: IssueTracker & IssueListingTracker = {
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: false,
				supportsIssueListing: true,
			},
			getIssue: async () => issue,
			listIssues: async () => [issue],
			listIssueStatuses: async () => new Map([[issue.id, issue.status]]),
			closeIssue: async () => {},
		};
		const provider = makeSandboxClient(
			{ sandboxId: "s1", sandboxRunId: "r1", workspacePath: dir },
			calls,
		);
		const deps = { ...(await depsFor(repos, provider)), issueTracker: override ?? tracker };
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}
	function dispatch(base: string) {
		return fetch(`${base}/projects/${projectId}/issues/dispatch`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ issueId: issue.id, agent: "test-agent", maxCostUsd: 2 }),
		});
	}

	test("lists and dispatches a hosted issue without Seeds, with full task context and persisted dedupe", async () => {
		const base = await boot();
		const list = await fetch(`${base}/projects/${projectId}/issues`);
		expect(await list.json()).toMatchObject({
			supported: true,
			issues: [{ id: "acme/web#1", runId: null }],
		});
		const results = await Promise.all([dispatch(base), dispatch(base)]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
		const bodies = await Promise.all(results.map((r) => r.json()));
		expect(bodies[0].run.id).toBe(bodies[1].run.id);
		const rows = await repos.runs.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.prompt).toContain("No overflow at 375px");
		expect(rows[0]?.seedId).toBe(issue.id);
		// New HTTP handler instance, same database receipt (no in-memory idempotency store).
		await handle?.stop();
		handle = undefined;
		const restarted = await boot();
		issue = { ...issue, ready: false, status: "closed" };
		expect((await dispatch(restarted)).status).toBe(200);
		expect(await repos.runs.listAll()).toHaveLength(1);
	});

	test("denies spectator access to issue content and execution", async () => {
		const base = await boot(undefined, publicReadAuth(bearerAuth("operator-test-token")));
		expect((await fetch(`${base}/projects/${projectId}/issues`)).status).toBe(403);
		expect((await dispatch(base)).status).toBe(403);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("shares the persisted receipt with the standalone automatic controller over HTTP", async () => {
		const fixture = new URL("../../../extensions/tracker-github/src/dev-server.ts", import.meta.url)
			.pathname;
		const adapter = Bun.spawn([process.execPath, "--env-file=/dev/null", fixture], {
			env: { PATH: process.env.PATH },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = adapter.stdout.getReader();
			const first = await reader.read();
			reader.releaseLock();
			const { port } = JSON.parse(new TextDecoder().decode(first.value)) as { port: number };
			const url = `http://127.0.0.1:${port}`;
			mkdirSync(join(dir, ".warren"));
			writeFileSync(join(dir, ".warren/config.yaml"), `tracker:\n  url: ${url}\n`);
			const tracker = new ProjectTracker(
				createWarrenConfigCache(),
				{
					WARREN_TRACKER_ALLOWED_URLS: JSON.stringify([url]),
				},
				new RemoteTracker({ baseUrl: url }),
			);
			const base = await boot(tracker);
			const list = await fetch(`${base}/projects/${projectId}/issues`);
			expect(await list.json()).toMatchObject({ supported: true, issues: [{ id: issue.id }] });
			const manual = await dispatch(base);
			expect(manual.status).toBe(201);
			for (let attempt = 0; attempt < 2; attempt++) {
				const worker = Bun.spawn([process.execPath, "--env-file=/dev/null", fixture], {
					env: {
						PATH: process.env.PATH,
						AUTO_DISPATCH_ENABLED: "true",
						TRACKER_BEARER: "fixture",
						WARREN_BASE_URL: base,
						WARREN_API_TOKEN: "fixture",
						WARREN_AGENT: "test-agent",
						WARREN_PROJECT_MAP: JSON.stringify({ "acme/web": projectId }),
						AUTO_STATE_PATH: join(dir, "controller.sqlite"),
						AUTO_MAX_COST_USD: "2",
						AUTO_DAILY_BUDGET_USD: "5",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const stderr = await new Response(worker.stderr).text();
				expect({ exit: await worker.exited, stderr }).toEqual({ exit: 0, stderr: "" });
			}
			expect(await repos.runs.listAll()).toHaveLength(1);
			expect((await repos.runs.listAll())[0]?.prompt).toContain("Acceptance: tests pass");
		} finally {
			adapter.kill();
			await adapter.exited;
		}
	}, 15000);

	test("refuses stale eligibility and wrong-repository execution before provider creation", async () => {
		const base = await boot();
		issue = { ...issue, ready: false };
		expect((await dispatch(base)).status).toBe(400);
		issue = { ...issue, ready: true, repositoryUrl: "https://github.com/acme/other" };
		expect((await dispatch(base)).status).toBe(400);
		expect(await repos.runs.listAll()).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});
