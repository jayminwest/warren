import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	makePrivateGitFixture,
	type PrivateGitFixture,
} from "../../sandbox/git-scope.test-helpers.ts";
import { WorkspaceGitScopeError } from "../../sandbox/git-scope.ts";
import { workspaceGitPinFor } from "../../workspace/git/host-git.ts";
import { ensureWorkspaceGitPin, pinWorkspaceGit, unpinWorkspaceGit } from "./git-pin.ts";

describe("local engine git pinning (warren-8926, warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
	});
	afterEach(() => {
		unpinWorkspaceGit(fx.ws);
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("pinWorkspaceGit registers the validated private git dir", () => {
		const scope = pinWorkspaceGit(fx.ws, fx.source);
		expect(scope.gitDir).toBe(fx.gitDir);
		const pin = workspaceGitPinFor(fx.ws);
		expect(pin?.gitDir).toBe(fx.gitDir);
		// The private dir is its own common dir: no host refs are reachable.
		expect(pin?.commonDir).toBe(fx.gitDir);
		unpinWorkspaceGit(fx.ws);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});

	test("the pin's verify hook rejects a symlink planted after pinning", () => {
		pinWorkspaceGit(fx.ws, fx.source);
		const verify = workspaceGitPinFor(fx.ws)?.verify;
		expect(verify).toBeDefined();
		expect(() => verify?.()).not.toThrow();
		symlinkSync(join(fx.root, "elsewhere"), join(fx.gitDir, "logs", "planted"));
		expect(() => verify?.()).toThrow(/is a symlink/);
	});

	test("refuses clone- and worktree-backed workspaces", () => {
		expect(() => pinWorkspaceGit(fx.ws, { kind: "clone", branch: "b" })).toThrow(
			WorkspaceGitScopeError,
		);
		expect(() =>
			pinWorkspaceGit(fx.ws, { kind: "worktree", branch: "b", gitCommonDir: fx.hostGitDir }),
		).toThrow(WorkspaceGitScopeError);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
		// The manifest re-pin path leaves legacy rows unpinned instead of throwing.
		expect(() => ensureWorkspaceGitPin(fx.ws, { kind: "clone", branch: "b" })).not.toThrow();
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});

	test("ensureWorkspaceGitPin keeps an existing pin", () => {
		pinWorkspaceGit(fx.ws, fx.source);
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${fx.siblingGitDir}\n`);
		ensureWorkspaceGitPin(fx.ws, fx.source);
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(fx.gitDir);
	});

	test("ensureWorkspaceGitPin re-validates the git dir from the manifest after a restart", () => {
		// A rewritten `.git` pointer is ignored: host git never reads it.
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${fx.siblingGitDir}\n`);
		ensureWorkspaceGitPin(fx.ws, fx.source);
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(fx.gitDir);
		unpinWorkspaceGit(fx.ws);
		// A tampered git dir is refused.
		writeFileSync(join(fx.gitDir, "commondir"), `${fx.hostGitDir}\n`);
		expect(() => ensureWorkspaceGitPin(fx.ws, fx.source)).toThrow(WorkspaceGitScopeError);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});
});
