import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-326f: the explicit `existingBranch` dispatch — check out an EXISTING
 * push-remote branch and push back to it. Formalized onto the row as
 * ref + targetBranch (the repair-run pattern), so providers and reap keep
 * reading the fields they already read; the fail-closed remote probe runs
 * before the run row exists.
 */
describe("spawnRun: existingBranch (warren-326f)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("pins the row's ref + targetBranch to the branch and the composed branch to it", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "follow up on the PR",
			existingBranch: "fix/pr-head",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async (cmd) => {
				// ls-remote probe: the branch exists on the push remote.
				if (cmd.includes("ls-remote")) {
					return { stdout: "abc123\trefs/heads/fix/pr-head\n", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			refreshProjectFn: async (input) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		const reread = await repos.runs.require(run.id);
		expect(reread.targetBranch).toBe("fix/pr-head");
		expect(reread.ref).toBe("fix/pr-head");
		// The workspace branch IS the existing branch, and its base is the same
		// ref (branch === baseBranch) so reap skips PR opening and pushes back.
		expect(reread.branch).toBe("fix/pr-head");
		const upBody = calls[0]?.body as { branch?: string; baseBranch?: string };
		expect(upBody.branch).toBe("fix/pr-head");
		expect(upBody.baseBranch).toBe("fix/pr-head");
	});

	test("fails closed BEFORE the run row when the branch is absent from the remote", async () => {
		const { client } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "follow up on the PR",
				existingBranch: "ghost/branch",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async (cmd) => {
					if (cmd.includes("ls-remote")) {
						return { stdout: "", stderr: "", exitCode: 0 };
					}
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			}),
		).rejects.toThrow(/does not exist on the push remote/);

		// No side effects: no row, no provider contact.
		const all = await repos.runs.listAll();
		expect(
			all.every((r) => r.agentName !== "refactor-bot" || r.prompt !== "follow up on the PR"),
		).toBe(true);
		expect(client.calls.length).toBe(0);
	});
});
