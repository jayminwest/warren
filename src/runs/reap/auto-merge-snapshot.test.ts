import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitOrThrow, mkdtempOutsideRepo } from "../../workspace/git/test-fixture.ts";
import { type RunAutoMergeArmInput, runAutoMergeArm } from "./auto-merge-arm.ts";
import { fakeExec, fakeForge, TEST_REPO_REF } from "./test-helpers.ts";
import type { ReapExec } from "./types.ts";

function inputFor(exec: ReapExec): RunAutoMergeArmInput {
	return {
		projectAutoMerge: { method: "squash", protectedPaths: [] },
		run: { id: "run_security" },
		project: { gitUrl: "https://github.com/x/y.git", localPath: `${tmpdir()}/unused-host` },
		prUrl: "fake://x/y/pulls/1",
		prNumber: 1,
		repoRef: TEST_REPO_REF,
		prRef: { forge: "fake", key: "x/y#1", number: 1, webUrl: "fake://x/y/pulls/1" },
		branch: "agent/run",
		baseBranch: "main",
		workspacePath: "/untrusted/worktree",
		forge: fakeForge(),
		exec,
		emit: async () => {},
	};
}

describe("auto-merge remote snapshot", () => {
	test.each([
		"base",
		"head",
		"sha",
	])("refuses arming after failed %s resolution and removes the snapshot", async (failure) => {
		const fake = fakeExec({
			showStdout: "pr:\n  autoMerge:\n    method: squash\n",
			nameOnlyDiff: "safe.ts\0",
		});
		let snapshot = "";
		const exec: ReapExec = {
			run: async (cmd, args, opts) => {
				snapshot = opts.cwd;
				if (args[0] === "fetch" && args.at(-1)?.endsWith(`/${failure}`)) {
					throw new Error("fetch error containing secret credential");
				}
				if (failure === "sha" && args[0] === "rev-parse") return { stdout: "main", stderr: "" };
				return fake.exec.run(cmd, args, opts);
			},
		};
		const input = inputFor(exec);
		(input.forge as ReturnType<typeof fakeForge>).setAutoMergeArmCapability(true);
		const events: unknown[] = [];
		input.forge.armAutoMerge = async () => {
			throw new Error("must not arm");
		};
		await runAutoMergeArm({
			...input,
			emit: async (kind, payload) => {
				events.push({ kind, payload });
			},
		});
		expect(events).toEqual([
			{
				kind: "reap.auto_merge_skipped",
				payload: { reason: failure === "head" ? "diff_unreadable" : "off" },
			},
		]);
		expect(fake.calls.some((call) => call.args[0] === "diff")).toBe(false);
		expect(existsSync(snapshot)).toBe(false);
	});

	test("ignores rewritten shared base, head, remote-tracking refs, and Git config", async () => {
		const root = mkdtempOutsideRepo("auto-merge-security-");
		const remote = join(root, "remote");
		const host = join(root, "host");
		const workspace = join(root, "workspace");
		const git = async (cwd: string, ...args: string[]) =>
			(
				await fixtureGitOrThrow(cwd, [
					"-c",
					"commit.gpgsign=false",
					"-c",
					"core.hooksPath=/dev/null",
					// CI runners have no global identity; commits must not depend on one.
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@warren.invalid",
					...args,
				])
			).stdout.trim();
		try {
			await mkdir(remote);
			await git(remote, "init", "-b", "main");
			await mkdir(join(remote, ".warren"));
			await mkdir(join(remote, "docs"));
			await writeFile(
				join(remote, ".warren/config.yaml"),
				"pr:\n  autoMerge:\n    method: squash\n    protectedPaths: [docs/]\n",
			);
			await writeFile(join(remote, "docs/policy.md"), "original\n");
			await git(remote, "add", ".");
			await git(remote, "commit", "-m", "base policy");
			const base = await git(remote, "rev-parse", "HEAD");
			await git(root, "clone", remote, host);
			await git(host, "worktree", "add", "-b", "agent/run", workspace);
			await writeFile(join(workspace, "docs/policy.md"), "protected edit\n");
			await git(workspace, "commit", "-am", "protected change");
			const head = await git(workspace, "rev-parse", "HEAD");
			await git(workspace, "push", "origin", "agent/run");
			// The sandbox grants writes to this common gitdir. Weaken only the
			// local policy, then hide the pushed change behind the local refs.
			await writeFile(
				join(workspace, ".warren/config.yaml"),
				"pr:\n  autoMerge:\n    method: squash\n",
			);
			await git(workspace, "commit", "-am", "weaken local policy");
			const malicious = await git(workspace, "rev-parse", "HEAD");
			await git(workspace, "update-ref", "refs/heads/main", malicious);
			await git(workspace, "update-ref", "refs/remotes/origin/main", malicious);
			await git(workspace, "update-ref", "refs/heads/agent/run", base);
			await git(workspace, "config", `url.${host}.insteadOf`, remote);
			const calls: { args: readonly string[]; cwd: string }[] = [];
			const exec: ReapExec = {
				run: async (_cmd, args, opts) => {
					calls.push({ args, cwd: opts.cwd });
					return fixtureGitOrThrow(opts.cwd, [...args]);
				},
			};
			const input = inputFor(exec);
			const forge = fakeForge();
			forge.setAutoMergeArmCapability(true);
			let armed = false;
			forge.armAutoMerge = async () => {
				armed = true;
				throw new Error("must not arm");
			};
			for (const workspacePath of [workspace, null]) {
				const events: unknown[] = [];
				await runAutoMergeArm({
					...input,
					forge,
					project: { gitUrl: remote, localPath: host },
					workspacePath,
					emit: async (kind, payload) => {
						events.push({ kind, payload });
					},
				});
				expect(events).toEqual([
					{
						kind: "reap.auto_merge_skipped",
						payload: { reason: "protected_path", paths: ["docs/policy.md"] },
					},
				]);
			}
			expect(armed).toBe(false);
			expect(
				calls
					.filter((call) => call.args[0] === "diff")
					.every((call) => call.args.at(-1) === `${base}...${head}`),
			).toBe(true);
			expect(calls.every((call) => call.cwd !== host && !existsSync(call.cwd))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
