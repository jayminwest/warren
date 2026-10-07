import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	adminDirOf,
	makeWorktreeFixture,
	type WorktreeFixture,
} from "../../sandbox/git-scope.test-helpers.ts";
import { WorkspaceGitScopeError } from "../../sandbox/git-scope.ts";
import { workspaceGitPinFor } from "../../workspace/git/host-git.ts";
import type { MaterializedWorkspaceSource } from "../../workspace/materialize.ts";
import { ensureWorkspaceGitPin, pinWorkspaceGit, unpinWorkspaceGit } from "./git-pin.ts";

describe("local engine git pinning (warren-8926)", () => {
	let fx: WorktreeFixture;
	let source: MaterializedWorkspaceSource;
	beforeEach(() => {
		fx = makeWorktreeFixture();
		source = { kind: "worktree", branch: "warren/run", gitCommonDir: fx.common };
	});
	afterEach(() => {
		unpinWorkspaceGit(fx.ws);
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("pinWorkspaceGit registers the validated admin dir", () => {
		const scope = pinWorkspaceGit(fx.ws, source);
		expect(scope.gitDir).toBe(adminDirOf(fx.ws));
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(adminDirOf(fx.ws));
		expect(workspaceGitPinFor(fx.ws)?.commonDir).toBe(scope.commonDir);
		unpinWorkspaceGit(fx.ws);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});

	test("refuses clone-backed workspaces (their git metadata is run-writable)", () => {
		expect(() => pinWorkspaceGit(fx.ws, { kind: "clone", branch: "b" })).toThrow(
			WorkspaceGitScopeError,
		);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
		// The manifest re-pin path skips (rather than throws on) a legacy clone row.
		expect(() => ensureWorkspaceGitPin(fx.ws, { kind: "clone", branch: "b" })).not.toThrow();
	});

	test("ensureWorkspaceGitPin keeps an existing pin without re-reading .git", () => {
		const admin = adminDirOf(fx.ws);
		pinWorkspaceGit(fx.ws, source);
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${adminDirOf(fx.sibling)}\n`);
		ensureWorkspaceGitPin(fx.ws, source);
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(admin);
	});

	test("ensureWorkspaceGitPin re-validates from the manifest after a restart", () => {
		ensureWorkspaceGitPin(fx.ws, source);
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(adminDirOf(fx.ws));
		unpinWorkspaceGit(fx.ws);
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${adminDirOf(fx.sibling)}\n`);
		expect(() => ensureWorkspaceGitPin(fx.ws, source)).toThrow(WorkspaceGitScopeError);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});
});
