import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IssueNotFoundError } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * #1234: POST /runs must validate a dispatched seedId against the wired
 * IssueTracker before any side effects, instead of only discovering it's
 * missing in the post-dispatch metadata write (which swallows the failure).
 */
describe("POST /runs — seedId validation (#1234)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});

		// Real on-disk localPath so the project-refresh path inside POST
		// /runs (warren-1bb6) can pass its existsSync probe before the
		// stubbed spawn handles git fetch + reset --hard origin/main.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectLocalPath = await mkdtemp(join(tmpdir(), "warren-handlers-seedval-proj-"));

		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: projectLocalPath,
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("unknown seedId with a tracker wired → 404 issue_not_found, no run row created", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const calls: { method: string; path: string; body: unknown }[] = [];
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_seedbad00000", sandboxRunId: "run_seedbad00000", workspacePath: "/tmp/ws" },
			calls,
		);
		const issueTracker: IssueTracker = {
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: true,
			},
			getIssue: async () => {
				throw new IssueNotFoundError("seed-missing not found");
			},
			listIssueStatuses: async () => new Map(),
			closeIssue: async () => {},
		};
		const deps = { ...(await depsFor(repos, sandboxClient)), issueTracker };
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				seedId: "seed-missing",
			}),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("issue_not_found");
		expect(calls).toEqual([]);
		expect((await repos.runs.listAll()).length).toBe(0);
	});
});
