import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runGit } from "./exec.ts";
import {
	assertFixtureHermetic,
	createGitFixture,
	createGitFixtureSync,
	fixtureGit,
	type GitFixture,
	gitFixtureEnv,
} from "./test-fixture.ts";

/**
 * warren-cfa7: regression guards for the git-fixture hermeticity helper.
 *
 * The observed damage (2026-07-30, pre-commit hook context): fixture commits
 * ('base'/'pr') landed on the INVOKING worktree's branch ref and its index
 * was emptied, because a fixture spawned git with the hook's exported
 * GIT_DIR/GIT_INDEX_FILE inherited. These tests prove the helper's spawn-site
 * env severing + discovery ceiling make that class impossible, and that the
 * post-setup guard (`assertFixtureHermetic`, embedded in createGitFixture)
 * catches any fixture whose git dir resolves outside itself.
 */

/** Repo-context GIT_* vars a parent `git commit` exports to its hooks. */
const HOSTILE_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
] as const;

function resolveReal(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

describe("gitFixtureEnv", () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const key of HOSTILE_KEYS) {
			saved[key] = process.env[key];
			process.env[key] = `/hostile/${key.toLowerCase()}`;
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test("severs every inherited GIT_* var and pins the discovery ceiling to the parent", () => {
		process.env.GIT_AUTHOR_NAME = "hostile-author";
		const env = gitFixtureEnv("/tmp/warren-some-fixture/repo");
		for (const key of Object.keys(env)) {
			if (key === "GIT_CEILING_DIRECTORIES") continue;
			expect(key.startsWith("GIT_")).toBe(false);
		}
		// The ceiling is the fixture's parent: git may find the fixture's own
		// .git but can never chdir up past the parent into an enclosing repo.
		expect(env.GIT_CEILING_DIRECTORIES).toBe("/tmp/warren-some-fixture");
		expect(env.PATH).toBe(process.env.PATH);
		delete process.env.GIT_AUTHOR_NAME;
	});

	test("extra entries merge over the scrub; undefined deletes (so the ceiling can be probed)", () => {
		const env = gitFixtureEnv("/tmp/x/repo", {
			GIT_AUTHOR_DATE: "2005-04-07T22:13:13",
			GIT_CEILING_DIRECTORIES: undefined,
		});
		expect(env.GIT_AUTHOR_DATE).toBe("2005-04-07T22:13:13");
		expect(env.GIT_CEILING_DIRECTORIES).toBeUndefined();
	});
});

describe("createGitFixture", () => {
	let fixture: GitFixture | null = null;

	afterEach(() => {
		fixture?.cleanup();
		fixture = null;
	});

	test("creates the repo under a mkdtemp'd absolute path — never cwd-relative", async () => {
		fixture = await createGitFixture({ prefix: "warren-fixture-abs-" });
		expect(isAbsolute(fixture.root)).toBe(true);
		expect(isAbsolute(fixture.path)).toBe(true);
		// Under the OS temp dir (realpath-normalized for macOS /var→/private/var).
		expect(resolveReal(fixture.root).startsWith(resolveReal(tmpdir()))).toBe(true);
		expect(fixture.path).toBe(join(fixture.root, "repo"));
		// The post-setup guard ran: git-dir resolves to the fixture's own .git.
		const res = await fixture.git(["rev-parse", "--git-dir"]);
		expect(res.exitCode).toBe(0);
		expect(resolveReal(resolve(fixture.path, res.stdout.trim()))).toBe(
			join(resolveReal(fixture.path), ".git"),
		);
	});

	test("cleanup removes the whole fixture root", async () => {
		const f = await createGitFixture({ prefix: "warren-fixture-cleanup-" });
		expect(existsSync(f.root)).toBe(true);
		f.cleanup();
		expect(existsSync(f.root)).toBe(false);
	});

	test("repo-local identity is pinned; initCommit lands on the fixture branch", async () => {
		fixture = await createGitFixture({ prefix: "warren-fixture-id-", initCommit: "base" });
		const author = await fixture.git(["log", "-1", "--format=%an <%ae>"]);
		expect(author.stdout.trim()).toBe("Fixture <fixture@warren.invalid>");
		const branch = await fixture.git(["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(branch.stdout.trim()).toBe("main");
	});
});

describe("assertFixtureHermetic guard", () => {
	let outer: GitFixture | null = null;

	afterEach(() => {
		outer?.cleanup();
		outer = null;
	});

	test("accepts a well-formed fixture repo", async () => {
		outer = await createGitFixture({ prefix: "warren-fixture-guard-ok-" });
		await expect(assertFixtureHermetic(outer.path)).resolves.toBeUndefined();
	});

	test("rejects a repo-less directory instead of discovering an enclosing repo", async () => {
		outer = await createGitFixture({ prefix: "warren-fixture-guard-plain-", initCommit: "x" });
		const plain = join(outer.path, "plain");
		mkdirSync(plain);
		// Without the guard this rev-parse would walk up and resolve to the
		// ENCLOSING repo — the exact escape the ceiling pins shut.
		await expect(assertFixtureHermetic(plain)).rejects.toThrow(/rev-parse --git-dir/);
	});
});

describe("discovery containment", () => {
	let outer: GitFixture | null = null;

	afterEach(() => {
		outer?.cleanup();
		outer = null;
	});

	test("rev-parse from a repo-less subdir stops at the ceiling; without it the enclosing repo leaks in", async () => {
		outer = await createGitFixture({ prefix: "warren-fixture-ceiling-", initCommit: "x" });
		const sub = join(outer.path, "plain", "sub");
		mkdirSync(sub, { recursive: true });

		// With the pinned ceiling, discovery from the subdir fails closed.
		const blocked = await fixtureGit(sub, ["rev-parse", "--git-dir"]);
		expect(blocked.exitCode).not.toBe(0);

		// Without the ceiling the SAME call resolves to the enclosing repo —
		// proving the ceiling (not luck) is what contains discovery.
		const leaking = await fixtureGit(sub, ["rev-parse", "--git-dir"], {
			env: { GIT_CEILING_DIRECTORIES: undefined },
		});
		expect(leaking.exitCode).toBe(0);
		expect(resolveReal(resolve(sub, leaking.stdout.trim()))).toBe(
			join(resolveReal(outer.path), ".git"),
		);
	});
});

describe("hostile pre-commit-hook env regression (warren-cfa7)", () => {
	test("fixture commits can't land on the invoking repo's ref or index", async () => {
		const outerDir = process.cwd();
		const outerEnv = gitFixtureEnv(outerDir);
		const outerGit = (args: string[]) => runGit(args, { cwd: outerDir, env: outerEnv });

		const headBefore = (await outerGit(["rev-parse", "HEAD"])).stdout.trim();
		const branchBefore = (await outerGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		const statusBefore = (await outerGit(["status", "--porcelain"])).stdout;

		// Simulate the hook context: repo-context GIT_* point at the INVOKING
		// repo. A fixture spawn that inherited these would commit onto its ref.
		const saved: Record<string, string | undefined> = {};
		for (const key of HOSTILE_KEYS) saved[key] = process.env[key];
		let fixture: GitFixture | null = null;
		try {
			process.env.GIT_DIR = join(outerDir, ".git");
			process.env.GIT_WORK_TREE = outerDir;
			process.env.GIT_INDEX_FILE = join(outerDir, ".git", "index");
			process.env.GIT_PREFIX = "";

			fixture = await createGitFixture({ prefix: "warren-fixture-hostile-" });
			await Bun.write(join(fixture.path, "f.txt"), "fixture\n");
			expect((await fixture.git(["add", "f.txt"])).exitCode).toBe(0);
			expect((await fixture.git(["commit", "-q", "-m", "fixture commit"])).exitCode).toBe(0);

			// The commit landed in the FIXTURE...
			const log = await fixture.git(["log", "-1", "--format=%s"]);
			expect(log.stdout.trim()).toBe("fixture commit");
			// ...and a fixture git call can never see the outer repo: if the env
			// severing regressed, GIT_DIR above would make this resolve to the
			// invoking repo's git dir instead of the fixture's own.
			const gitDir = await fixture.git(["rev-parse", "--git-dir"]);
			expect(resolveReal(resolve(fixture.path, gitDir.stdout.trim()))).toBe(
				join(resolveReal(fixture.path), ".git"),
			);
			await assertFixtureHermetic(fixture.path);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fixture?.cleanup();
		}

		// ...while the invoking repo is byte-for-byte untouched: same HEAD,
		// same branch ref, same index/worktree status (no emptied index, no
		// fixture debris staged).
		expect((await outerGit(["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
		expect((await outerGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
			branchBefore,
		);
		expect((await outerGit(["status", "--porcelain"])).stdout).toBe(statusBefore);
	});

	test("the sync fixture API severs inheritance the same way", () => {
		const outerDir = process.cwd();
		const saved = process.env.GIT_DIR;
		process.env.GIT_DIR = join(outerDir, ".git");
		try {
			const fixture = createGitFixtureSync({ prefix: "warren-fixture-sync-", initCommit: "base" });
			try {
				expect(fixture.path).toBe(join(fixture.root, "repo"));
				// dirname is the discovery ceiling's parent anchor.
				expect(gitFixtureEnv(fixture.path).GIT_CEILING_DIRECTORIES).toBe(
					dirname(resolve(fixture.path)),
				);
				const res = fixture.git(["rev-parse", "--git-dir"]);
				expect(res.exitCode).toBe(0);
				expect(resolveReal(resolve(fixture.path, res.stdout.trim()))).toBe(
					join(resolveReal(fixture.path), ".git"),
				);
			} finally {
				fixture.cleanup();
			}
		} finally {
			if (saved === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved;
		}
	});
});
