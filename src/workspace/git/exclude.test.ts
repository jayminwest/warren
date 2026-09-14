import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installWorkspaceExcludes } from "./exclude.ts";
import { createGitFixture, fixtureGitOrThrow, gitFixtureEnv } from "./test-fixture.ts";

describe("installWorkspaceExcludes", () => {
	for (const source of ["configured", "xdg"] as const) {
		test(`preserves ${source} ignore patterns alongside run exclusions`, async () => {
			const fixture = await createGitFixture({ initCommit: "fixture" });
			try {
				const workspace = join(fixture.root, "workspace");
				const configHome = join(fixture.root, "config");
				const ignore = join(configHome, "git", "ignore");
				await mkdir(join(configHome, "git"), { recursive: true });
				await writeFile(ignore, "*.private\n");
				if (source === "configured") {
					await fixtureGitOrThrow(fixture.path, ["config", "core.excludesFile", ignore]);
				}
				await fixtureGitOrThrow(fixture.path, ["worktree", "add", "-b", "run", workspace]);
				const hostEnv = gitFixtureEnv(workspace, {
					GIT_CONFIG_GLOBAL: "/dev/null",
					XDG_CONFIG_HOME: configHome,
				});
				const options = { workspacePath: workspace, kind: "worktree" as const, hostEnv };
				await installWorkspaceExcludes(options);
				await installWorkspaceExcludes(options);
				await mkdir(join(workspace, ".pi", "sessions"), { recursive: true });
				await writeFile(join(workspace, ".pi", "sessions", "run.jsonl"), "transcript");
				await writeFile(join(workspace, "local.private"), "private");
				await writeFile(join(workspace, "work.txt"), "work");
				await fixtureGitOrThrow(workspace, ["add", "-A"], { env: hostEnv });
				const staged = await fixtureGitOrThrow(workspace, ["diff", "--cached", "--name-only"]);
				expect(staged.stdout.trim()).toBe("work.txt");
				expect(await Bun.file(ignore).text()).toBe("*.private\n");
			} finally {
				fixture.cleanup();
			}
		});
	}
});
