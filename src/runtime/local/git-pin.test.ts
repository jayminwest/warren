import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fixtureGitCmd,
	makePrivateGitFixture,
	type PrivateGitFixture,
} from "../../sandbox/git-scope.test-helpers.ts";
import { WorkspaceGitScopeError } from "../../sandbox/git-scope.ts";
import type { SpawnResult } from "../../sandbox/types.ts";
import { hardenHostGit, workspaceGitPinFor } from "../../workspace/git/host-git.ts";
import {
	LegacyWorkspaceGitError,
	pinWorkspaceGit,
	sealWorkspaceGit,
	stopAgentProcess,
	unpinWorkspaceGit,
} from "./git-pin.ts";

describe("local engine git pinning and sealing (warren-8926, warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	let sealed: string;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
		sealed = join(fx.root, "gitdirs-sealed", "run");
	});
	afterEach(() => {
		unpinWorkspaceGit(fx.ws);
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("pinWorkspaceGit registers the private dir and refuses host git until the seal", () => {
		const scope = pinWorkspaceGit(fx.ws, fx.source);
		expect(scope.gitDir).toBe(fx.gitDir);
		const pin = workspaceGitPinFor(fx.ws);
		expect(pin?.gitDir).toBe(fx.gitDir);
		// The private dir is its own common dir: no host refs are reachable.
		expect(pin?.commonDir).toBe(fx.gitDir);
		expect(() => hardenHostGit(["status"], fx.ws)).toThrow(/not sealed yet/);
		unpinWorkspaceGit(fx.ws);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});

	test("sealWorkspaceGit stops the agent, moves the dir, and re-pins without a per-call check", async () => {
		pinWorkspaceGit(fx.ws, fx.source);
		const order: string[] = [];
		const report = await sealWorkspaceGit({
			workspacePath: fx.ws,
			source: fx.source,
			sealedGitDir: sealed,
			stopAgent: async () => {
				order.push(existsSync(fx.gitDir) ? "stopped-before-move" : "stopped-after-move");
			},
		});
		expect(order).toEqual(["stopped-before-move"]);
		expect(report?.sanitized).toEqual([]);
		expect(existsSync(fx.gitDir)).toBe(false);
		const pin = workspaceGitPinFor(fx.ws);
		expect(pin?.gitDir).toBe(sealed);
		expect(pin?.verify).toBeUndefined();
		// The sealed dir is a working repository for host git.
		expect(fixtureGitCmd(fx.ws, `--git-dir=${sealed}`, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
			"warren/run",
		);
		// Idempotent: a second seal is a no-op.
		expect(
			await sealWorkspaceGit({ workspacePath: fx.ws, source: fx.source, sealedGitDir: sealed }),
		).toBeNull();
	});

	test("sealWorkspaceGit is single-flight per workspace", async () => {
		let stops = 0;
		const input = {
			workspacePath: fx.ws,
			source: fx.source,
			sealedGitDir: sealed,
			stopAgent: async () => {
				stops += 1;
			},
		};
		const [a, b] = await Promise.all([sealWorkspaceGit(input), sealWorkspaceGit(input)]);
		expect(a).toBe(b);
		expect(stops).toBe(1);
	});

	test("the seal re-runs from the manifest after a restart, ignoring a rewritten .git", async () => {
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${fx.siblingGitDir}\n`);
		await sealWorkspaceGit({ workspacePath: fx.ws, source: fx.source, sealedGitDir: sealed });
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(sealed);
		// An already-moved dir (a crash between move and pin) is picked up as is.
		unpinWorkspaceGit(fx.ws);
		await sealWorkspaceGit({ workspacePath: fx.ws, source: fx.source, sealedGitDir: sealed });
		expect(workspaceGitPinFor(fx.ws)?.gitDir).toBe(sealed);
	});

	test("the seal sanitizes a planted symlink instead of refusing", async () => {
		symlinkSync(join(fx.root, "elsewhere"), join(fx.gitDir, "logs", "planted"));
		const report = await sealWorkspaceGit({
			workspacePath: fx.ws,
			source: fx.source,
			sealedGitDir: sealed,
		});
		expect(report?.sanitized).toEqual([join(sealed, "logs", "planted")]);
		expect(existsSync(join(sealed, "logs", "planted"))).toBe(false);
	});

	test("the seal refuses a planted commondir and leaves host git unpinned", async () => {
		writeFileSync(join(fx.gitDir, "commondir"), `${fx.hostGitDir}\n`);
		await expect(
			sealWorkspaceGit({ workspacePath: fx.ws, source: fx.source, sealedGitDir: sealed }),
		).rejects.toThrow(/commondir must not exist/);
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});

	test("a legacy worktree manifest gets its own error code and recovery hint", async () => {
		const legacy = {
			kind: "worktree" as const,
			branch: "warren/old",
			hostClonePath: fx.clone,
			gitCommonDir: fx.hostGitDir,
		};
		const err = await sealWorkspaceGit({
			workspacePath: fx.ws,
			source: legacy,
			sealedGitDir: sealed,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LegacyWorkspaceGitError);
		expect((err as LegacyWorkspaceGitError).code).toBe("legacy_worktree_workspace");
		expect((err as LegacyWorkspaceGitError).recoveryHint).toContain("warren/old");
		expect(() => pinWorkspaceGit(fx.ws, legacy)).toThrow(LegacyWorkspaceGitError);
	});

	test("clone-backed workspaces are refused at pin time and skipped at seal time", async () => {
		const clone = { kind: "clone" as const, branch: "b" };
		expect(() => pinWorkspaceGit(fx.ws, clone)).toThrow(WorkspaceGitScopeError);
		expect(
			await sealWorkspaceGit({ workspacePath: fx.ws, source: clone, sealedGitDir: sealed }),
		).toBeNull();
		expect(workspaceGitPinFor(fx.ws)).toBeUndefined();
	});
});

describe("stopAgentProcess", () => {
	function fakeProc(exited: Promise<number>): SpawnResult & { cancelled: number } {
		const proc = {
			cancelled: 0,
			pid: 1,
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			exited,
			cancel: () => {
				proc.cancelled += 1;
			},
		};
		return proc;
	}

	test("cancels the process and waits for it to exit", async () => {
		const proc = fakeProc(Promise.resolve(137));
		await stopAgentProcess(proc);
		expect(proc.cancelled).toBe(1);
		await stopAgentProcess(undefined);
		await stopAgentProcess(null);
	});

	test("fails closed when the process outlives the timeout", async () => {
		const proc = fakeProc(new Promise<number>(() => {}));
		await expect(stopAgentProcess(proc, 10)).rejects.toThrow(/did not exit/);
	});
});
