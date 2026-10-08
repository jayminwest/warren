/**
 * Real git fixtures for the git-scope tests (warren-8926, warren-3c1e): a
 * host clone plus two run workspaces (the run under test and a sibling),
 * each backed by its own private git dir over the clone's object store.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePrivateGitDir } from "../workspace/git/private-gitdir.ts";
import { scrubbedGitEnv } from "../workspace/git/test-fixture.ts";
import type { MaterializedWorkspaceSource } from "../workspace/materialize.ts";

export const FIXTURE_GIT_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
};

/** Run fixture git with a scrubbed env (no inherited GIT_DIR etc.). */
export function fixtureGitCmd(cwd: string, ...args: string[]): string {
	const res = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...scrubbedGitEnv(), ...FIXTURE_GIT_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (res.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
	}
	return res.stdout.toString().trim();
}

export interface PrivateGitFixture {
	readonly root: string;
	readonly clone: string;
	/** The host clone's `.git`. */
	readonly hostGitDir: string;
	readonly ws: string;
	readonly gitDir: string;
	readonly source: MaterializedWorkspaceSource;
	readonly sibling: string;
	readonly siblingGitDir: string;
}

/** Materialize with every inherited `GIT_*` var dropped, then restore them. */
async function materialize(
	clone: string,
	hostGitDir: string,
	ws: string,
	gitDir: string,
	branch: string,
): Promise<MaterializedWorkspaceSource> {
	const saved: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_") && value !== undefined) {
			saved[key] = value;
			delete process.env[key];
		}
	}
	try {
		const result = await materializePrivateGitDir({
			hostClone: { topLevel: clone, gitCommonDir: hostGitDir },
			workspacePath: ws,
			gitDir,
			branch,
			startPoint: "main",
		});
		return {
			kind: "private",
			branch,
			hostClonePath: clone,
			gitCommonDir: result.hostGitDir,
			gitDir: result.gitDir,
			gitConfigSha256: result.configSha256,
		};
	} finally {
		Object.assign(process.env, saved);
	}
}

export async function makePrivateGitFixture(): Promise<PrivateGitFixture> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "warren-git-scope-")));
	const clone = join(root, "clone");
	mkdirSync(clone);
	fixtureGitCmd(clone, "init", "-q", "-b", "main");
	writeFileSync(join(clone, "README"), "hi\n");
	fixtureGitCmd(clone, "add", "README");
	fixtureGitCmd(clone, "commit", "-q", "-m", "init");
	fixtureGitCmd(clone, "remote", "add", "origin", "https://example.invalid/o/r.git");
	const hostGitDir = join(clone, ".git");
	const ws = join(root, "ws-run");
	const gitDir = join(root, "gitdirs", "run");
	const sibling = join(root, "ws-sibling");
	const siblingGitDir = join(root, "gitdirs", "sibling");
	const source = await materialize(clone, hostGitDir, ws, gitDir, "warren/run");
	await materialize(clone, hostGitDir, sibling, siblingGitDir, "warren/sibling");
	return { root, clone, hostGitDir, ws, gitDir, source, sibling, siblingGitDir };
}
