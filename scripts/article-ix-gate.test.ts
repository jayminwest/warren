import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { createGitFixtureSync } from "../src/workspace/git/test-fixture.ts";

// Guards for warren-7b2f: the Article IX gate in .github/workflows/auto-merge.yml
// is the executable form of docs/CONSTITUTION.md Article IX — a PR touching the
// constitution, the cron triggers, the built-in agent definitions or that
// workflow itself must never have auto-merge armed.
//
// It used to read the changed-file list with
// `gh api .../pulls/:n/files -q '.[].path'`. The REST files API keys each entry
// `filename`; only gh's GraphQL-backed `gh pr view --json files` uses `path`.
// The selector was carried over unchanged when #609 switched between the two,
// so from 2026-07-17 the list was one empty string per file — the grep matched
// nothing and the gate FAILED OPEN on every PR, unconditionally. That is how
// #644 auto-merged docs/CONSTITUTION.md, .warren/triggers.yaml and the gate
// itself with no human sign-off. (The seed guessed an async race; the run logs
// show both of its runs permitting, which a race would not explain.)
//
// Two properties are asserted here, because either alone leaves the hole open:
//   1. the diff is read from git, so no API field name can silently empty it;
//   2. an empty or unreadable file list refuses rather than permits — the
//      failure mode that turned one wrong word into a silent bypass.
//
// Workflows can't run locally, so these parse the YAML and execute the shell the
// workflow embeds against a real scratch git repo.

const REPO_ROOT = resolve(import.meta.dir, "..");

type Step = {
	name?: string;
	id?: string;
	run?: string;
	if?: string;
	uses?: string;
	with?: unknown;
};
type Job = { if?: string; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function loadAutoMerge(): Workflow {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows/auto-merge.yml"), "utf8");
	return load(raw) as Workflow;
}

function steps(): Step[] {
	return loadAutoMerge().jobs?.["enable-auto-merge"]?.steps ?? [];
}

/** The `run` script of the first step whose name starts with `prefix`. */
function stepScript(prefix: string): string {
	const step = steps().find((s) => s.name?.startsWith(prefix));
	if (step?.run === undefined) throw new Error(`no step "${prefix}" with a run script`);
	return step.run;
}

const ARTICLE_IX = "Article IX check";

/**
 * Build a scratch git repo whose PR branch changes `files`, then execute the
 * workflow's embedded Article IX shell against it. Returns the `hit=` value the
 * step wrote to $GITHUB_OUTPUT — `hit=true` means auto-merge is refused.
 *
 * warren-cfa7: the scratch repo is built with the canonical hermetic fixture
 * helper. The previous version spawned git with the inherited environment, so
 * under the repo's own pre-commit hook (which exports GIT_DIR/GIT_INDEX_FILE)
 * the scratch 'base'/'pr' commits landed on the INVOKING worktree's branch ref
 * and its index was rewritten. The fixture helper severs every inherited GIT_*
 * var, pins the discovery ceiling, and guards that the repo resolves inside
 * the fixture.
 */
function runGate(files: string[], opts: { corruptBaseSha?: boolean } = {}) {
	const fixture = createGitFixtureSync({
		prefix: "warren-article-ix-",
		identity: { name: "test", email: "test@example.com" },
	});
	const dir = fixture.path;
	const git = fixture.git;
	try {
		writeFileSync(join(dir, "seed.txt"), "base\n");
		git(["add", "-A"]);
		git(["commit", "-qm", "base"]);
		const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();

		git(["checkout", "-qb", "pr"]);
		for (const f of files) {
			const abs = join(dir, f);
			Bun.spawnSync({ cmd: ["mkdir", "-p", resolve(abs, "..")] });
			writeFileSync(abs, "changed\n");
		}
		if (files.length > 0) {
			git(["add", "-A"]);
			git(["commit", "-qm", "pr"]);
		}
		const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

		const outputFile = join(dir, "gh-output");
		writeFileSync(outputFile, "");
		const result = Bun.spawnSync({
			// `-e` matches GitHub's default `run:` shell (`bash -e {0}`), so an
			// errexit-triggered early exit shows up here rather than in CI.
			cmd: ["bash", "-e", "-c", stepScript(ARTICLE_IX)],
			cwd: dir,
			// Explicit allowlist env (no inherited GIT_*) + a pinned discovery
			// ceiling: the workflow script's own `git diff` can only ever see the
			// scratch repo (warren-cfa7).
			env: {
				PATH: process.env.PATH ?? "",
				GITHUB_OUTPUT: outputFile,
				BASE_SHA: opts.corruptBaseSha ? "0".repeat(40) : baseSha,
				HEAD_SHA: headSha,
				GIT_CEILING_DIRECTORIES: dirname(dir),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = readFileSync(outputFile, "utf8");
		return {
			hit: output.includes("hit=true") ? true : output.includes("hit=false") ? false : null,
			exitCode: result.exitCode,
			log: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	} finally {
		fixture.cleanup();
	}
}

describe("the gate reads git, not the async files API", () => {
	test("the step does not call the endpoint that races (warren-7b2f)", () => {
		// Comments are stripped first — the step explains the old bug in prose,
		// and that prose naturally names the endpoint it no longer calls.
		const code = stepScript(ARTICLE_IX)
			.split("\n")
			.filter((line) => !line.trim().startsWith("#"))
			.join("\n");
		expect(code).not.toContain("/files");
		expect(code).not.toContain("gh api");
		expect(code).toContain("git diff --name-only");
	});

	test("the checkout pins the head SHA, not the async merge ref", () => {
		// `refs/pull/N/merge` — actions/checkout's default for pull_request — is
		// computed asynchronously too, so defaulting reintroduces the same race.
		const checkout = steps().find((s) => s.uses?.startsWith("actions/checkout"));
		expect(checkout).toBeDefined();
		const ref = (checkout?.with as { ref?: string } | undefined)?.ref ?? "";
		expect(ref).toContain("pull_request.head.sha");
	});
});

describe("protected paths are refused", () => {
	const protectedPaths = [
		"docs/CONSTITUTION.md",
		".warren/triggers.yaml",
		"src/registry/builtins/claude-code.ts",
		".github/workflows/auto-merge.yml",
	];

	for (const path of protectedPaths) {
		test(`${path} refuses auto-merge`, () => {
			const r = runGate([path]);
			expect(r.hit).toBe(true);
			expect(r.log).toContain("protected paths changed");
		});
	}

	test("a protected path hidden among many ordinary files is still caught", () => {
		const files = Array.from({ length: 120 }, (_, i) => `src/filler-${i}.ts`);
		files.push("docs/CONSTITUTION.md");
		const r = runGate(files);
		expect(r.hit).toBe(true);
	});

	test("an ordinary PR is allowed through", () => {
		const r = runGate(["src/runs/pr.ts", "README.md"]);
		expect(r.hit).toBe(false);
		expect(r.log).toContain("no protected paths");
	});

	test("a path merely containing a protected name is not a false positive", () => {
		// The regex is anchored at ^, so these are ordinary files.
		const r = runGate(["docs/archive/docs/CONSTITUTION.md", "src/ui/src/registry/builtins/x.ts"]);
		expect(r.hit).toBe(false);
	});
});

describe("the gate fails closed", () => {
	test("an empty changed-file list refuses instead of permitting", () => {
		// The exact shape of the original bug: no files reported.
		const r = runGate([]);
		expect(r.hit).toBe(true);
		expect(r.log).toContain("fail closed");
	});

	test("an unreadable diff refuses instead of permitting", () => {
		const r = runGate(["docs/CONSTITUTION.md"], { corruptBaseSha: true });
		expect(r.hit).toBe(true);
		expect(r.log).toContain("fail closed");
	});

	test("every run states its decision and file count in the log", () => {
		// The old step printed nothing on the permit path, which is why the
		// fail-open went unnoticed for as long as it did.
		for (const r of [runGate(["README.md"]), runGate(["docs/CONSTITUTION.md"]), runGate([])]) {
			expect(r.log).toContain("Article IX:");
		}
		expect(runGate(["README.md", "src/runs/pr.ts"]).log).toMatch(/2 changed file\(s\)/);
	});

	test("the merge step is gated on the check having explicitly passed", () => {
		const merge = steps().find((s) => s.name?.startsWith("Enable auto-merge"));
		// `== 'false'` and not `!= 'true'`: a step that dies before writing an
		// output leaves the value empty, which must not read as a pass.
		expect(merge?.if).toBe("steps.protected.outputs.hit == 'false'");
	});
});

describe("auto-merge is scoped to the repo owner", () => {
	test("a third party's PR is never auto-merged", () => {
		const gate = loadAutoMerge().jobs?.["enable-auto-merge"]?.if ?? "";
		expect(gate).toContain("github.event.pull_request.user.login == github.repository_owner");
	});
});
