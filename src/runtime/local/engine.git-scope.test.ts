import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGitScopeError } from "../../sandbox/git-scope.ts";
import { workspaceGitPinFor } from "../../workspace/git/host-git.ts";
import { fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import { branchExists, listWorktrees } from "../../workspace/git/worktree.ts";
import type { RunSpec } from "../contract.ts";
import { LocalEngine } from "./engine.ts";
import { localHomePath, localWorkspacePath, resolveLocalStateRoots } from "./paths.ts";
import { LocalRunStore } from "./run-store.ts";

/**
 * warren-8926: the engine validates the worktree git scope after
 * materialization and before the agent runs. A scope that fails validation
 * rejects the create and rolls the materialized worktree back.
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

describe("LocalEngine.create git scope validation (warren-8926)", () => {
	let root: string;
	let dataDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warren-engine-scope-"));
		dataDir = mkdtempSync(join(tmpdir(), "warren-engine-scope-data-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("rejects an invalid scope and removes the materialized worktree", async () => {
		const host = join(root, "host");
		await fixtureGitOrThrow(root, ["init", "-q", "-b", "main", host]);
		writeFileSync(join(host, "README.md"), "# repo\n");
		await fixtureGitOrThrow(host, ["add", "."]);
		await fixtureGitOrThrow(host, [
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.invalid",
			"commit",
			"-q",
			"-m",
			"init",
		]);
		// A shared store that resolves outside the clone fails validation.
		const outside = join(root, "outside-logs");
		mkdirSync(outside);
		rmSync(join(host, ".git", "logs"), { recursive: true, force: true });
		symlinkSync(outside, join(host, ".git", "logs"));

		const engine = new LocalEngine({
			serverEnv: { WARREN_DATA_DIR: dataDir, WARREN_BIND_PORT: "8181" },
			store: new LocalRunStore(),
		});
		const spec: RunSpec = {
			runId: "run_gs1",
			originUrl: "https://example.invalid/o/r.git",
			branch: "warren/run_gs1",
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
		await expect(engine.create(spec)).rejects.toThrow(WorkspaceGitScopeError);

		const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: dataDir });
		const workspacePath = localWorkspacePath(roots, "local-run_gs1");
		expect(existsSync(workspacePath)).toBe(false);
		expect(existsSync(localHomePath(roots, "local-run_gs1"))).toBe(false);
		expect(workspaceGitPinFor(workspacePath)).toBeUndefined();
		const worktrees = await listWorktrees(host);
		expect(worktrees.some((e) => e.worktree.endsWith("run_gs1"))).toBe(false);
		expect(await branchExists(host, "warren/run_gs1")).toBe(false);
	});
});
