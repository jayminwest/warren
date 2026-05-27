import { type Burrow, NotFoundError } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import type { OpenPullRequestInput, OpenPullRequestResult } from "../pr.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly.
 */
export async function makePool(
	client: BurrowClient,
	repos: Repos,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client);
	return pool;
}

export interface FakeFs {
	readonly fs: ReapFs;
	readonly files: Map<string, string>;
	readonly dirs: Set<string>;
}

export function fakeFs(seed: Record<string, string> = {}): FakeFs {
	const files = new Map<string, string>(Object.entries(seed));
	const dirs = new Set<string>();
	const fs: ReapFs = {
		mkdirp: async (path) => {
			dirs.add(path);
		},
		readFile: async (path) => files.get(path) ?? null,
		writeFile: async (path, contents) => {
			files.set(path, contents);
		},
		readdir: async (path) => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const out = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.includes("/")) continue;
				out.add(rest);
			}
			return [...out].sort();
		},
	};
	return { fs, files, dirs };
}

export interface FakeExec {
	readonly exec: ReapExec;
	readonly calls: { cmd: string; args: readonly string[]; cwd: string }[];
	readonly fail: { reason: string } | null;
}

export interface FakeExecOpts {
	/** Throw on every git push call (default: succeed). */
	fail?: string;
	/** Throw on git rev-list calls (default: succeed). */
	failRevList?: string;
	/**
	 * Stdout for `git rev-list --count <ref>..HEAD`. Default `"1"` so
	 * existing tests with `branchPushed: true` see commitsAhead=1 (real
	 * work shipped) rather than the empty-push shape (warren-f3bb).
	 */
	revListCount?: string;
	/**
	 * When `true`, `git diff --cached --quiet …` throws (exit non-zero =
	 * staged changes present). Default `false` — exits zero = no staged
	 * delta. Used by warren-343a plot-commit tests to flip the
	 * has-staged-delta branch under stagePlotForCommit.
	 */
	stagedDelta?: boolean;
}

export function fakeExec(opts: FakeExecOpts = {}): FakeExec {
	const calls: { cmd: string; args: readonly string[]; cwd: string }[] = [];
	const fail = opts.fail !== undefined ? { reason: opts.fail } : null;
	const failRevList = opts.failRevList ?? null;
	const revListCount = opts.revListCount ?? "1";
	const stagedDelta = opts.stagedDelta === true;
	const exec: ReapExec = {
		run: async (cmd, args, opt) => {
			calls.push({ cmd, args, cwd: opt.cwd });
			const isRevList = cmd === "git" && args[0] === "rev-list";
			if (isRevList) {
				if (failRevList !== null) throw new Error(failRevList);
				return { stdout: `${revListCount}\n`, stderr: "" };
			}
			const isDiffCached =
				cmd === "git" &&
				args[0] === "diff" &&
				args.includes("--cached") &&
				args.includes("--quiet");
			if (isDiffCached) {
				if (stagedDelta) throw new Error("staged changes present");
				return { stdout: "", stderr: "" };
			}
			if (fail !== null) throw new Error(fail.reason);
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls, fail };
}

export interface FakeBurrowClientOpts {
	/**
	 * Body the workspace-side seeds file (`.seeds/issues.jsonl`) returns
	 * over `client.http.files.read`. `undefined` (default) makes the read
	 * throw `NotFoundError` — i.e. the agent never created the file —
	 * mirroring the no-op path. Pass a string to exercise the mirror code.
	 */
	seedsIssuesBody?: string;
	/**
	 * Body the workspace-side plans file (`.seeds/plans.jsonl`) returns
	 * over `client.http.files.read`. `undefined` (default) makes the read
	 * throw `NotFoundError`. Pass a string to exercise mirrorPlans.
	 */
	seedsPlansBody?: string;
	/** Override `client.http.files.read` end-to-end (advanced). */
	filesRead?: (burrowId: string, path: string) => Promise<{ contents: string }>;
}

export function fakeBurrowClient(burrow: Burrow, opts: FakeBurrowClientOpts = {}): BurrowClient {
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	});
	(client.http.burrows as unknown as { get: (id: string) => Promise<Burrow> }).get = async () =>
		burrow;
	const filesRead =
		opts.filesRead ??
		(async (_burrowId: string, path: string) => {
			if (path === ".seeds/issues.jsonl" && opts.seedsIssuesBody !== undefined) {
				return { contents: opts.seedsIssuesBody };
			}
			if (path === ".seeds/plans.jsonl" && opts.seedsPlansBody !== undefined) {
				return { contents: opts.seedsPlansBody };
			}
			throw new NotFoundError(`file not found: ${path}`);
		});
	(
		client.http.files as unknown as {
			read: (burrowId: string, path: string) => Promise<{ contents: string }>;
		}
	).read = filesRead;
	return client;
}

export function makeBurrow(overrides: Partial<Burrow> = {}): Burrow {
	const now = new Date(2026, 4, 8, 12, 0, 0);
	return {
		id: "bur_aaaaaaaaaaaa",
		state: "active",
		projectRoot: "/data/projects/x/y",
		workspacePath: "/data/burrow/ws",
		branch: "agent/refactor-bot/run-1",
		baseBranch: "main",
		network: "restricted",
		createdAt: now,
		updatedAt: now,
		destroyedAt: null,
		...overrides,
	} as unknown as Burrow;
}

export interface Ctx {
	db: WarrenDb;
	repos: Repos;
	broker: RunEventBroker;
	runId: string;
	projectPath: string;
	workspacePath: string;
}

export async function setup(): Promise<Ctx> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
	});
	await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
	await repos.runs.markRunning(run.id);
	return {
		db,
		repos,
		broker: new RunEventBroker(),
		runId: run.id,
		projectPath: project.localPath,
		workspacePath: "/data/burrow/ws",
	};
}

export function fakeOpenPr(
	responses: ReadonlyArray<OpenPullRequestResult | (() => OpenPullRequestResult)>,
): {
	openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	calls: OpenPullRequestInput[];
} {
	const calls: OpenPullRequestInput[] = [];
	let i = 0;
	const openPr = async (input: OpenPullRequestInput): Promise<OpenPullRequestResult> => {
		calls.push(input);
		const r = responses[i++];
		if (r === undefined) throw new Error("fakeOpenPr: out of responses");
		return typeof r === "function" ? r() : r;
	};
	return { openPr, calls };
}

export {
	type Burrow,
	BurrowClient,
	BurrowClientPool,
	createRepos,
	NotFoundError,
	openDatabase,
	RunEventBroker,
};
