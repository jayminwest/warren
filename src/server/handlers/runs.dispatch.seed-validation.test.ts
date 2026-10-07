import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IssueNotFoundError } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

type GetIssue = IssueTracker["getIssue"];

function trackerWith(getIssue: GetIssue, isGitNative = true): IssueTracker {
	return {
		capabilities: {
			supportsPlans: false,
			supportsMetadata: false,
			supportsScheduledIssues: false,
			isGitNative,
		},
		getIssue,
		listIssueStatuses: async () => new Map(),
		closeIssue: async () => {},
	};
}

const alwaysMissing: GetIssue = async () => {
	throw new IssueNotFoundError("seed-missing not found");
};

/**
 * #1234: POST /runs must validate a dispatched seedId against the wired
 * IssueTracker before any side effects, instead of only discovering it's
 * missing in the post-dispatch metadata write (which swallows the failure).
 * warren-a25a (#1302): a git-native miss refreshes the host clone once and
 * retries before rejecting.
 */
describe("POST /runs — seedId validation (#1234)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let calls: { method: string; path: string; body: unknown }[];
	let refreshes: number;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		calls = [];
		refreshes = 0;
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

	async function dispatch(issueTracker: IssueTracker): Promise<Response> {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_seedval00000", sandboxRunId: "run_seedval00000", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps: ServerDeps = {
			...(await depsFor(repos, sandboxClient)),
			issueTracker,
			// Counts the seed-retry refresh only: spawnRun's own refresh is
			// fed through its input bag, not this deps seam.
			refreshProjectFn: async (input) => {
				refreshes++;
				const row = await input.repo.require(input.id);
				return { project: row, headSha: "deadbeef".repeat(5), ref: input.ref ?? "main" };
			},
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: project.id,
				prompt: "hello",
				seedId: "seed-missing",
			}),
		});
	}

	async function expectNotFound(res: Response): Promise<void> {
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("issue_not_found");
		expect(calls).toEqual([]);
		expect((await repos.runs.listAll()).length).toBe(0);
	}

	test("unknown seedId with a tracker wired → 404 issue_not_found, no run row created", async () => {
		const res = await dispatch(trackerWith(alwaysMissing));
		await expectNotFound(res);
		// The git-native miss refreshed the clone exactly once before rejecting.
		expect(refreshes).toBe(1);
	});

	test("refreshes the clone once and dispatches when the seed is only upstream (#1302)", async () => {
		const res = await dispatch(
			trackerWith(async (_ctx, id) => {
				if (refreshes === 0) throw new IssueNotFoundError(`${id} not found`);
				return { id, title: "fresh", status: "open" };
			}),
		);
		expect(res.status).toBe(201);
		expect(refreshes).toBe(1);
		expect((await repos.runs.listAll()).length).toBe(1);
	});

	test("skips the refresh retry for a remote (non-git-native) tracker", async () => {
		const res = await dispatch(trackerWith(alwaysMissing, false));
		await expectNotFound(res);
		expect(refreshes).toBe(0);
	});
});
