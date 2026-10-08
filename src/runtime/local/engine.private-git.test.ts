import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed } from "../../sandbox/sandbox.ts";
import type { SandboxProfile, SpawnCommand } from "../../sandbox/types.ts";
import { fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { LocalEngine } from "./engine.ts";
import {
	localGitDirPath,
	localHomePath,
	localWorkspacePath,
	resolveLocalStateRoots,
} from "./paths.ts";
import { LocalRunStore } from "./run-store.ts";

/**
 * warren-3c1e end-to-end through the REAL platform sandbox: the agent is a
 * shell script run by `runSandboxed` against the profile the engine built.
 * It commits, creates and deletes refs, and tries to write the host clone's
 * git metadata. Then host-side finalize pushes — or refuses to, when the run
 * planted a symlink in its private git dir.
 */
const isDarwin = process.platform === "darwin";
const canSandbox = isDarwin || (process.platform === "linux" && Bun.which("bwrap") !== null);
// macOS: /usr/bin/git, the binary the sandbox git preflight falls back to.
const gitBinDir = isDarwin
	? "/usr/bin"
	: join(realpathSync(Bun.which("git") ?? "/usr/bin/git"), "..");

const savedGitEnv: Record<string, string | undefined> = {};
beforeAll(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			savedGitEnv[key] = process.env[key];
			delete process.env[key];
		}
	}
});
afterAll(() => {
	for (const [key, value] of Object.entries(savedGitEnv)) {
		if (value !== undefined) process.env[key] = value;
	}
});

const TERMINAL_LINE = JSON.stringify({
	kind: "state_change",
	stream: "system",
	payload: { type: "result" },
});

const fakeAdapter: AgentRuntimeAdapter = {
	runtimeId: "fake",
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
	parseEvents: (line: string) => [
		JSON.parse(line) as { kind: "text"; stream: "stdout"; payload: unknown },
	],
} as unknown as AgentRuntimeAdapter;

async function bootstrap(root: string): Promise<{ host: string; remote: string }> {
	const remote = join(root, "remote.git");
	const host = join(root, "host");
	await fixtureGitOrThrow(root, ["init", "--bare", "-b", "main", remote]);
	await fixtureGitOrThrow(root, ["init", "-b", "main", host]);
	await fixtureGitOrThrow(host, ["config", "user.email", "host@example.com"]);
	await fixtureGitOrThrow(host, ["config", "user.name", "Host"]);
	writeFileSync(join(host, "README.md"), "# repo\n");
	await fixtureGitOrThrow(host, ["add", "."]);
	await fixtureGitOrThrow(host, ["commit", "-m", "init"]);
	await fixtureGitOrThrow(host, ["remote", "add", "origin", remote]);
	await fixtureGitOrThrow(host, ["push", "origin", "main"]);
	// A packed base ref, so deleting it in the run rewrites packed-refs.
	await fixtureGitOrThrow(host, ["pack-refs", "--all"]);
	return { host, remote };
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
	return (await fixtureGitOrThrow(cwd, args)).stdout.trim();
}

describe("LocalEngine: private git metadata in the real sandbox (warren-3c1e)", () => {
	let root: string;
	let dataDir: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "warren-engine-pgit-")));
		dataDir = realpathSync(mkdtempSync(join(tmpdir(), "warren-engine-pgit-data-")));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	});

	/** An engine whose "agent" is `script` run inside the real sandbox. */
	function engineRunning(script: string): LocalEngine {
		const spawn = (profile: SandboxProfile, _command: SpawnCommand) =>
			runSandboxed(
				{
					...profile,
					toolchainPaths: [...profile.toolchainPaths, gitBinDir],
					setEnv: { ...profile.setEnv, GIT_CONFIG_NOSYSTEM: "1" },
				},
				{
					argv: [
						"/bin/sh",
						"-c",
						`PATH=${gitBinDir}:$PATH; { ${script}\n} > "$HOME/agent.log" 2>&1; echo '${TERMINAL_LINE}'`,
					],
				},
			);
		return new LocalEngine({
			serverEnv: { WARREN_DATA_DIR: dataDir, WARREN_BIND_PORT: "8181" },
			store: new LocalRunStore(),
			drive: {
				spawn,
				registry: { get: (id) => (id === "fake" ? fakeAdapter : undefined) },
			},
		});
	}

	function spec(runId: string, host: string, remote: string): RunSpec {
		return {
			runId,
			originUrl: remote,
			branch: `warren/${runId}`,
			baseBranch: "main",
			hostClonePathHint: host,
			runtimeId: "fake",
			prompt: "do it",
			network: "none",
			env: {},
			mode: "batch",
			seedFiles: [],
			metadata: {},
		};
	}

	async function awaitTerminal(engine: LocalEngine, runId: string): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			const status = await engine.status({ runId, sandboxId: "", providerRunId: runId });
			if (["succeeded", "failed", "cancelled"].includes(status.phase)) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("run never terminalized");
	}

	function probeLog(sandboxId: string): string {
		const home = localHomePath(resolveLocalStateRoots({ WARREN_DATA_DIR: dataDir }), sandboxId);
		return readFileSync(join(home, "agent.log"), "utf8");
	}

	test.skipIf(!canSandbox)(
		"edits its own refs, cannot move host refs, and finalize pushes its commit",
		async () => {
			const { host, remote } = await bootstrap(root);
			const hostGit = join(host, ".git");
			const baseBefore = await gitOut(host, "rev-parse", "main");
			const hostRefsBefore = await gitOut(host, "for-each-ref");
			const engine = engineRunning(
				[
					"git -c user.name=a -c user.email=a@example.invalid commit -q --allow-empty -m agent",
					"echo commit=$?",
					"git branch scratch && git branch -D scratch; echo loose_delete=$?",
					"git tag t1 && git tag -d t1; echo tag_delete=$?",
					"git update-ref -d refs/remotes/origin/main; echo packed_delete=$?",
					`git --git-dir=${hostGit} update-ref refs/heads/main HEAD; echo host_update_ref=$?`,
					`echo 0 > ${join(hostGit, "refs", "heads", "main")}; echo host_ref_write=$?`,
					`echo x >> ${join(hostGit, "packed-refs")}; echo host_packed_write=$?`,
				].join("\n"),
			);
			const handle = await engine.create(spec("pg1", host, remote));
			await awaitTerminal(engine, "pg1");
			const log = probeLog(handle.sandboxId);
			for (const ok of ["commit", "loose_delete", "tag_delete", "packed_delete"]) {
				expect(log).toContain(`${ok}=0`);
			}
			for (const denied of ["host_update_ref", "host_ref_write", "host_packed_write"]) {
				expect(log).not.toContain(`${denied}=0`);
			}
			// The host clone's refs never moved and never saw the run branch.
			expect(await gitOut(host, "rev-parse", "main")).toBe(baseBefore);
			expect(await gitOut(host, "for-each-ref")).toBe(hostRefsBefore);

			const result = await engine.finalize(handle, {
				branch: "warren/pg1",
				baseBranch: "main",
				push: true,
				artifacts: [],
			});
			expect(result.pushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dataDir });
			const ws = localWorkspacePath(roots, handle.sandboxId);
			expect(await gitOut(remote, "rev-parse", "warren/pg1")).toBe(
				await gitOut(ws, "rev-parse", "HEAD"),
			);
			// Teardown reclaims the private git dir with the workspace.
			const gitDir = localGitDirPath(roots, handle.sandboxId);
			expect(existsSync(gitDir)).toBe(true);
			await engine.terminate(handle);
			expect(existsSync(gitDir)).toBe(false);
			expect(existsSync(ws)).toBe(false);
		},
		60_000,
	);

	test.skipIf(!canSandbox)(
		"refuses host-side finalize when the run planted a symlink in its git dir",
		async () => {
			const { host, remote } = await bootstrap(root);
			const secret = join(root, "secret");
			writeFileSync(secret, "untouched\n");
			// The push's remote-tracking update would append to this reflog.
			const engine = engineRunning(
				[
					"git -c user.name=a -c user.email=a@example.invalid commit -q --allow-empty -m agent",
					"gd=$(git rev-parse --absolute-git-dir)",
					'mkdir -p "$gd/logs/refs/remotes/origin/warren"',
					`ln -s ${secret} "$gd/logs/refs/remotes/origin/warren/pg2"; echo plant=$?`,
				].join("\n"),
			);
			const handle = await engine.create(spec("pg2", host, remote));
			await awaitTerminal(engine, "pg2");
			expect(probeLog(handle.sandboxId)).toContain("plant=0");

			const result = await engine.finalize(handle, {
				branch: "warren/pg2",
				baseBranch: "main",
				push: true,
				artifacts: [],
			});
			expect(result.pushed).toBe(false);
			// The pre-call boundary check refused the push; it never ran.
			expect(JSON.stringify(result.stages)).toMatch(/branch_push.*is a symlink/);
			expect(readFileSync(secret, "utf8")).toBe("untouched\n");
			expect(await gitOut(remote, "branch", "--list", "warren/pg2")).toBe("");
			await engine.terminate(handle);
		},
		60_000,
	);
});
