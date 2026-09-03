import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunTerminalState } from "../../db/schema.ts";
import type { Forge, RepoRef } from "../../forge/contract.ts";
import { FAKE_FORGE_KIND, FakeForge, type FakeForgeOptions } from "../../forge/fake/fake-forge.ts";
import type { PreviewSidecarResolver } from "../../preview/launch/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { LocalSidecarRegistry } from "../../runtime/local/preview/registry.ts";
import { createLocalSidecarsResolver } from "../../runtime/local/preview/sidecars.ts";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { RunEventBroker } from "../events.ts";
import type { ReapExec, ReapFs, ReapRunResult } from "./types.ts";

/**
 * Build the reap runtime seams for tests over a fake provider (warren-e24d;
 * re-based onto `FakeProvider` in warren-ea0a when the burrow facade left).
 * Reap drives finalize/terminate/workspace resolution through a
 * `RuntimeProvider` and preview through a neutral sidecar resolver. This
 * helper threads the test's fake `fs`/`exec` into the provider's finalize
 * seams plus the sidecar resolver, so a test spreads `...reapDeps(provider,
 * { fs, exec })`.
 */
export function reapDeps(
	provider: FakeProvider,
	opts: { fs?: ReapFs; exec?: ReapExec } = {},
): { runtimeProvider: RuntimeProvider; previewSidecars: PreviewSidecarResolver } {
	return {
		runtimeProvider: provider.withFinalizeSeams(opts.fs, opts.exec),
		// warren-4bf3: the sidecar resolver is warren-owned now. Reap tests
		// never spawn sidecars (launch is faked), so a registry over a stub
		// profile lookup gives the resolver a real-but-empty facade — list
		// returns [], delete throws NotFoundError the sweeps tolerate.
		previewSidecars: createLocalSidecarsResolver(
			new LocalSidecarRegistry({ profileFor: () => stubProfile() }),
		),
	};
}

function stubProfile(): SandboxProfile {
	return {
		workspace: "/tmp/ws",
		home: "/tmp/home",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
}

/**
 * Build a `ReapRunResult` for tests that stub the reap step (bridges,
 * cancel). Every counter defaults to a no-op; pass `overrides` to set the
 * terminal `state` or any field under assertion. Keeping the full shape in
 * one place means a new `ReapRunResult` field only updates here, not in
 * every stubbed caller.
 */
export function makeReapRunResult(overrides: Partial<ReapRunResult> = {}): ReapRunResult {
	return {
		state: "succeeded" as RunTerminalState,
		failureReason: null,
		providerError: null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
		previewState: null,
		previewPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: false,
		salvageRescueRef: null,
		salvagePath: null,
		errors: [],
		alreadyTerminal: false,
		...overrides,
	};
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
	readonly calls: {
		cmd: string;
		args: readonly string[];
		cwd: string;
		env?: Record<string, string | undefined>;
	}[];
	readonly fail: { reason: string } | null;
}

export interface FakeExecOpts {
	/** Throw on every git push call (default: succeed). */
	fail?: string;
	/**
	 * Throw ONLY on `git push` calls, leaving add/diff/commit/rev-list intact
	 * (default: succeed). Distinct from `fail` (which throws on every non-routed
	 * command): used by warren-486c to exercise the durability-push failure path
	 * where the clone commit lands but the origin push is rejected.
	 */
	failPush?: string;
	/** Throw on git rev-list calls (default: succeed). */
	failRevList?: string;
	/**
	 * Stdout for `git rev-parse --verify <ref>` (warren-ba08: the pre-push
	 * `origin/<branch>` tip finalize pins on a ref-dispatch repair run).
	 * Default a fixed fake SHA; pass `""` to simulate a missing tracking ref.
	 */
	revParse?: string;
	/**
	 * Throw on `git cat-file -e <ref>:<path>` (default: succeed) — simulates
	 * a seed drop absent from the base ref, i.e. untracked in every ref
	 * (warren-0f18's seed_reset sweep test).
	 */
	failCatFile?: boolean;
	/**
	 * Stdout for `git rev-list --count <ref>..HEAD`. Default `"1"` so
	 * existing tests with `branchPushed: true` see commitsAhead=1 (real
	 * work shipped) rather than the empty-push shape (warren-f3bb).
	 */
	revListCount?: string;
	/**
	 * Stdout for `git diff --numstat <base>..<head>` (warren-ab2b outcome
	 * facts). Default `""` (no rows → zeroed totals).
	 */
	numstat?: string;
	/**
	 * Stdout for `git merge-base <base> HEAD` (warren-b19e base_sha). Default
	 * {@link FAKE_REV_PARSE_SHA} — a plausible resolved workspace base.
	 */
	mergeBase?: string;
	/**
	 * When `true`, `git diff --cached --quiet …` throws (exit non-zero =
	 * staged changes present). Default `false` — exits zero = no staged
	 * delta. Used by warren-343a plot-commit tests to flip the
	 * has-staged-delta branch under stagePlotForCommit.
	 */
	stagedDelta?: boolean;
	/**
	 * Stdout for `git status --porcelain` (warren-72b9 dropped-commit
	 * probe). Default `""` (clean tree = deliberate no-op). Set to a
	 * non-empty string (e.g. `" M src/foo.ts"`) to simulate uncommitted
	 * changes left behind by an agent that never ran `git commit`.
	 */
	gitStatus?: string;
	/** Throw on `git status --porcelain` calls (default: succeed). */
	failGitStatus?: string;
}

/** Match a `git <sub> …` invocation for the fakeExec command router. */
function isGitSub(cmd: string, args: readonly string[], sub: string): boolean {
	return cmd === "git" && args[0] === sub;
}

type ExecResult = { stdout: string; stderr: string };

function handleCatFile(failCatFile: boolean): ExecResult {
	if (failCatFile) throw new Error("path does not exist in ref");
	return { stdout: "", stderr: "" };
}

function handleRevList(failRevList: string | null, revListCount: string): ExecResult {
	if (failRevList !== null) throw new Error(failRevList);
	return { stdout: `${revListCount}\n`, stderr: "" };
}

/** warren-ba08: `git rev-parse --verify` exits non-zero (throws) when the ref is missing. */
function handleRevParse(revParse: string): ExecResult {
	if (revParse === "") throw new Error("fatal: Needed a single revision");
	return { stdout: `${revParse}\n`, stderr: "" };
}

/** The pre-run tip `fakeExec` resolves `origin/<branch>` to by default. */
export const FAKE_REV_PARSE_SHA = "0123456789abcdef0123456789abcdef01234567";

function handleStatus(failGitStatus: string | null, gitStatus: string): ExecResult {
	if (failGitStatus !== null) throw new Error(failGitStatus);
	return { stdout: gitStatus, stderr: "" };
}

function handleDiffCached(stagedDelta: boolean): ExecResult {
	if (stagedDelta) throw new Error("staged changes present");
	return { stdout: "", stderr: "" };
}

/** warren-b19e: `git merge-base <base> HEAD` resolves the workspace base SHA. */
function handleMergeBase(mergeBase: string): ExecResult {
	return { stdout: `${mergeBase}\n`, stderr: "" };
}

/** The `git diff` probes; split out of `route` to keep both under the complexity budget. */
function routeDiffProbe(
	args: readonly string[],
	stagedDelta: boolean,
	numstat: string,
): ExecResult | null {
	if (args.includes("--cached") && args.includes("--quiet")) {
		return handleDiffCached(stagedDelta);
	}
	if (args.includes("--numstat")) return { stdout: numstat, stderr: "" };
	return null;
}

export function fakeExec(opts: FakeExecOpts = {}): FakeExec {
	const calls: {
		cmd: string;
		args: readonly string[];
		cwd: string;
		env?: Record<string, string | undefined>;
	}[] = [];
	const fail = opts.fail !== undefined ? { reason: opts.fail } : null;
	const failPush = opts.failPush ?? null;
	const failRevList = opts.failRevList ?? null;
	const failCatFile = opts.failCatFile === true;
	const revListCount = opts.revListCount ?? "1";
	const revParse = opts.revParse ?? FAKE_REV_PARSE_SHA;
	const numstat = opts.numstat ?? "";
	const mergeBase = opts.mergeBase ?? FAKE_REV_PARSE_SHA;
	const stagedDelta = opts.stagedDelta === true;
	const gitStatus = opts.gitStatus ?? "";
	const failGitStatus = opts.failGitStatus ?? null;
	// Routed `git <sub>` reads, split out of `run` (and of each other) to keep
	// every function under the cognitive-complexity budget.
	const route = (cmd: string, args: readonly string[]): ExecResult | null => {
		if (isGitSub(cmd, args, "cat-file")) return handleCatFile(failCatFile);
		if (isGitSub(cmd, args, "rev-list")) return handleRevList(failRevList, revListCount);
		if (isGitSub(cmd, args, "rev-parse")) return handleRevParse(revParse);
		if (isGitSub(cmd, args, "status") && args.includes("--porcelain")) {
			return handleStatus(failGitStatus, gitStatus);
		}
		if (isGitSub(cmd, args, "merge-base")) return handleMergeBase(mergeBase);
		if (isGitSub(cmd, args, "diff")) return routeDiffProbe(args, stagedDelta, numstat);
		return null;
	};
	const exec: ReapExec = {
		run: async (cmd, args, opt) => {
			calls.push({ cmd, args, cwd: opt.cwd, env: opt.env });
			const routed = route(cmd, args);
			if (routed !== null) return routed;
			if (failPush !== null && isGitSub(cmd, args, "push")) throw new Error(failPush);
			if (fail !== null) throw new Error(fail.reason);
			return { stdout: "", stderr: "" };
		},
	};
	return { exec, calls, fail };
}

export interface FakeBurrowClientOpts {
	/**
	 * Body the workspace-side seeds file (`.seeds/issues.jsonl`) returns from
	 * the provider's tracker-read seam. `undefined` (default) reads as absent
	 * — i.e. the agent never created the file — mirroring the no-op path.
	 * Pass a string to exercise the mirror code.
	 */
	seedsIssuesBody?: string;
	/**
	 * Body the workspace-side plans file (`.seeds/plans.jsonl`) returns.
	 * `undefined` (default) reads as absent. Pass a string to exercise
	 * mirrorPlans.
	 */
	seedsPlansBody?: string;
	/** Override the tracker-read seam end-to-end (advanced). */
	filesRead?: (sandboxId: string, path: string) => Promise<{ contents: string }>;
}

/**
 * The sandbox fixture shape `fakeBurrowClient` consumes. Kept under the
 * historical helper names (warren-ea0a): the record is the workspace slice
 * the provider's `workspaceInfo` resolves.
 */
export interface FakeSandbox {
	id: string;
	workspacePath: string | null;
	branch: string;
}

export function fakeBurrowClient(
	sandbox: FakeSandbox,
	opts: FakeBurrowClientOpts = {},
): FakeProvider {
	// A filesRead override propagates its throws verbatim — the finalize
	// pipeline surfaces them as failed stages (only ABSENCE reads as null).
	const readTracker =
		opts.filesRead !== undefined
			? async (relPath: string) => (await opts.filesRead?.(sandbox.id, relPath))?.contents ?? null
			: async (relPath: string) => {
					if (relPath === ".seeds/issues.jsonl") return opts.seedsIssuesBody ?? null;
					if (relPath === ".seeds/plans.jsonl") return opts.seedsPlansBody ?? null;
					return null;
				};
	return new FakeProvider({
		sandboxId: sandbox.id,
		workspacePath: sandbox.workspacePath,
		branch: sandbox.branch,
		readTracker,
	});
}

export function makeBurrow(overrides: Partial<FakeSandbox> = {}): FakeSandbox {
	return {
		id: "bur_aaaaaaaaaaaa",
		workspacePath: "/data/sandbox/ws",
		branch: "agent/refactor-bot/run-1",
		...overrides,
	};
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
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
	});
	await repos.runs.markRunning(run.id);
	return {
		db,
		repos,
		broker: new RunEventBroker(),
		runId: run.id,
		projectPath: project.localPath,
		workspacePath: "/data/sandbox/ws",
	};
}

/* ----------------------------------------------------------------------- */
/* Forge seams (warren-45e6)                                                 */
/* ----------------------------------------------------------------------- */

/**
 * The RepoRef the test forges mint for the `setup()` project's clone URL
 * (`https://github.com/x/y.git`). Keyed `x/y` so FakeForge's store lines up
 * with the pre-migration `owner/repo` assertions.
 */
export const TEST_REPO_REF: RepoRef = { forge: FAKE_FORGE_KIND, key: "x/y" };

/**
 * A FakeForge that ALSO claims github.com clone URLs (the fake's own grammar
 * is `fake://` only). Reap tests exercise the semantic seam against this —
 * never a hand-rolled fetch mock.
 */
export function fakeForge(options: FakeForgeOptions = {}): FakeForge {
	const forge = new FakeForge(options);
	const inner = forge.parseRepoRef.bind(forge);
	forge.parseRepoRef = (cloneUrl: string): RepoRef | null =>
		inner(cloneUrl) ?? (cloneUrl.includes("github.com") ? TEST_REPO_REF : null);
	return forge;
}

/**
 * A contract-typed Forge stub: every method delegates to a FakeForge, with
 * per-method overrides for the failure shapes the fake cannot produce (a
 * `conflict` open, a `no_credential` find, a capability flip). Replaces the
 * pre-migration `fakeOpenPr` response-queue at the same semantic seam.
 */
export function stubForge(overrides: Partial<Forge> = {}): Forge {
	const inner = fakeForge();
	return {
		capabilities: inner.capabilities,
		parseRepoRef: (cloneUrl) => inner.parseRepoRef(cloneUrl),
		gitCredential: (ref) => inner.gitCredential(ref),
		openPullRequest: (ref, req) => inner.openPullRequest(ref, req),
		findPullRequest: (ref, q) => inner.findPullRequest(ref, q),
		getPullRequest: (ref, pr) => inner.getPullRequest(ref, pr),
		setPullRequestBody: (ref, pr, body) => inner.setPullRequestBody(ref, pr, body),
		listChecks: (ref, commit) => inner.listChecks(ref, commit),
		fetchJobLogTail: (ref, jobId, maxBytes) => inner.fetchJobLogTail(ref, jobId, maxBytes),
		deleteBranch: (ref, branch) => inner.deleteBranch(ref, branch),
		botIdentity: () => inner.botIdentity(),
		listInstallationRepos: () => inner.listInstallationRepos(),
		...overrides,
	};
}

export { createRepos, openDatabase, RunEventBroker };
