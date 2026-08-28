import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../sandbox/types.ts";
import { assertFixtureHermetic, fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import { branchExists, listWorktrees } from "../../workspace/git/worktree.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { LocalEngine, type LocalEngineDeps } from "./engine.ts";
import { localHomePath, localWorkspacePath, resolveLocalStateRoots } from "./paths.ts";
import { LocalRunStore } from "./run-store.ts";

/**
 * warren-326f end-to-end on the LocalProvider: an existing-branch dispatch
 * (branch === baseBranch) materializes a DETACHED worktree off the existing
 * branch, commits pushed at finalize land back on that branch, and teardown
 * keeps the branch ref (it predates the run and lives on the remote).
 */
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

async function bootstrapHostClone(
	root: string,
): Promise<{ host: string; remote: string; tip: string }> {
	// A bare "push remote", a host clone of it, and an existing branch checked
	// out in the host clone — the state refreshProjectClone leaves behind.
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	await fixtureGitOrThrow(root, ["init", "--bare", "-b", "main", remote]);
	await fixtureGitOrThrow(root, ["init", "-b", "main", seed]);
	writeFileSync(join(seed, "README.md"), "# repo\n");
	await fixtureGitOrThrow(seed, ["config", "user.email", "host@example.com"]);
	await fixtureGitOrThrow(seed, ["config", "user.name", "Host"]);
	await fixtureGitOrThrow(seed, ["add", "."]);
	await fixtureGitOrThrow(seed, ["commit", "-m", "init"]);
	await fixtureGitOrThrow(seed, ["push", remote, "main"]);
	await fixtureGitOrThrow(seed, ["checkout", "-b", "fix/pr-head"]);
	writeFileSync(join(seed, "pr.txt"), "pr work\n");
	await fixtureGitOrThrow(seed, ["add", "."]);
	await fixtureGitOrThrow(seed, ["commit", "-m", "pr commit"]);
	await fixtureGitOrThrow(seed, ["push", remote, "fix/pr-head"]);
	const host = join(root, "host");
	await fixtureGitOrThrow(root, ["clone", remote, host]);
	await fixtureGitOrThrow(host, ["config", "user.email", "host@example.com"]);
	await fixtureGitOrThrow(host, ["config", "user.name", "Host"]);
	// The refresh checks out the existing branch; HEAD sits on it.
	await fixtureGitOrThrow(host, ["checkout", "fix/pr-head"]);
	await assertFixtureHermetic(host);
	const tip = (await fixtureGitOrThrow(remote, ["rev-parse", "fix/pr-head"])).stdout.trim();
	return { host, remote, tip };
}

const fakeAdapter: AgentRuntimeAdapter = {
	runtimeId: "fake",
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
	parseEvents: (line: string) => [
		JSON.parse(line) as { kind: "text"; stream: "stdout"; payload: unknown },
	],
} as unknown as AgentRuntimeAdapter;

function immediateProc(lines: readonly string[], exitCode = 0): SpawnResult {
	const encoder = new TextEncoder();
	const body = lines.map((l) => `${l}\n`).join("");
	const stdout = new ReadableStream<Uint8Array>({
		start(ctrl) {
			if (body !== "") ctrl.enqueue(encoder.encode(body));
			ctrl.close();
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(ctrl) {
			ctrl.close();
		},
	});
	return {
		pid: 4321,
		stdout,
		stderr,
		exited: Promise.resolve(exitCode),
		cancel: () => {},
		closeStdin: () => Promise.resolve(),
		writeStdin: () => Promise.resolve(),
	};
}

const TERMINAL_LINE = JSON.stringify({
	kind: "state_change",
	stream: "system",
	payload: { type: "result" },
});

describe("LocalEngine: existing-branch dispatch (warren-326f)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warren-engine-existing-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("materializes detached onto the existing branch, pushes back, and keeps the branch", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "warren-engine-existing-data-"));
		const { host, remote, tip } = await bootstrapHostClone(root);
		const engine = new LocalEngine({
			serverEnv: { WARREN_DATA_DIR: dataDir, WARREN_BIND_PORT: "8181" },
			store: new LocalRunStore(),
			drive: {
				spawn: () => Promise.resolve(immediateProc([TERMINAL_LINE])),
				registry: { get: (id) => (id === "fake" ? fakeAdapter : undefined) },
			},
		} satisfies LocalEngineDeps);
		try {
			const spec: RunSpec = {
				runId: "run_ex1",
				originUrl: remote,
				branch: "fix/pr-head",
				baseBranch: "fix/pr-head",
				hostClonePathHint: host,
				runtimeId: "fake",
				prompt: "do it",
				network: "none",
				env: {},
				mode: "batch",
				seedFiles: [],
				metadata: {},
			};
			const handle = await engine.create(spec);
			const workspacePath = localWorkspacePath(
				resolveLocalStateRoots({ WARREN_DATA_DIR: dataDir }),
				handle.sandboxId,
			);

			// The workspace is a detached worktree at the branch tip — not a carve.
			const list = await listWorktrees(host);
			const entry = list.find((e) => e.worktree.endsWith("run_ex1"));
			expect(entry?.detached).toBe(true);
			expect(await branchExists(host, "fix/pr-head")).toBe(true);

			// The agent commits on the detached HEAD; finalize pushes HEAD:<branch>.
			writeFileSync(join(workspacePath, "follow-up.txt"), "follow-up work\n");
			await fixtureGitOrThrow(workspacePath, ["add", "."]);
			await fixtureGitOrThrow(workspacePath, ["commit", "-m", "follow-up commit"]);

			const result = await engine.finalize(handle, {
				branch: "fix/pr-head",
				baseBranch: "fix/pr-head",
				push: true,
				artifacts: [],
			});
			expect(result.pushed).toBe(true);

			// The push landed on the SAME remote branch (its tip advanced).
			const remoteTip = (
				await fixtureGitOrThrow(remote, ["rev-parse", "fix/pr-head"])
			).stdout.trim();
			expect(remoteTip).not.toBe(tip);
			expect(remoteTip).toBe(
				(await fixtureGitOrThrow(workspacePath, ["rev-parse", "HEAD"])).stdout.trim(),
			);

			// Teardown removes the worktree but keeps the pre-existing branch ref.
			await engine.terminate(handle);
			const homePath = localHomePath(
				resolveLocalStateRoots({ WARREN_DATA_DIR: dataDir }),
				handle.sandboxId,
			);
			rmSync(homePath, { recursive: true, force: true });
			expect(await branchExists(host, "fix/pr-head")).toBe(true);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
