import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-8b5f: the release job must be at least as strict as CI,
// must refuse to publish a release with no curated CHANGELOG section, and must
// keep a heartbeat on the auto-merge app credential — the credential whose
// silent death stops merges to main and therefore stops releases, with no
// failed run to notice.
//
// Workflows can't run locally, so these assert on the parsed YAML plus direct
// execution of the shell the workflow embeds.

const REPO_ROOT = resolve(import.meta.dir, "..");

type Step = {
	name?: string;
	id?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	uses?: string;
	with?: Record<string, string>;
};

type Job = { needs?: unknown; steps?: Step[] };

type Workflow = { jobs?: Record<string, Job> };

function loadRelease(): Workflow {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
	return load(raw) as Workflow;
}

function releaseSteps(job: string): Step[] {
	return loadRelease().jobs?.[job]?.steps ?? [];
}

/** The `run` script of the first step in `job` whose name starts with `prefix`. */
function stepScript(job: string, prefix: string): string {
	const step = releaseSteps(job).find((s) => s.name?.startsWith(prefix));
	if (step?.run === undefined) throw new Error(`no step "${prefix}" with a run script`);
	return step.run;
}

/** Bare `- run: X` steps (no name), as their command strings. */
function bareRunCommands(job: string): string[] {
	return releaseSteps(job)
		.filter((s) => s.name === undefined && typeof s.run === "string")
		.map((s) => (s.run ?? "").trim());
}

describe("release runs the real gate suite", () => {
	test("the release job runs check:all, not a hand-picked subset", () => {
		const commands = bareRunCommands("release");
		expect(commands).toContain("bun run check:all");
		// knip (check:deps) resolves the src/ui workspace and runs before
		// check:bundle-size builds it, so the UI deps must land first.
		expect(commands).toContain("bun run ui:install");
		expect(commands.indexOf("bun run ui:install")).toBeLessThan(
			commands.indexOf("bun run check:all"),
		);
	});

	test("the superseded four-gate subset is gone", () => {
		const commands = bareRunCommands("release");
		// These are all inside check:all now; listing them separately is what
		// let the manifest and the release drift apart in the first place.
		for (const stale of ["bun run lint", "bun run typecheck", "bun test"]) {
			expect(commands).not.toContain(stale);
		}
	});
});

/**
 * Execute the workflow's embedded changelog-extraction shell against a scratch
 * CHANGELOG.md, so the assertions exercise what the workflow really runs.
 */
function extractNotes(
	version: string,
	changelog: string,
): { exitCode: number; output: string; notes: string | null } {
	const script = stepScript("release", "Extract changelog notes");
	const dir = mkdtempSync(join(tmpdir(), "warren-changelog-"));
	try {
		writeFileSync(join(dir, "CHANGELOG.md"), changelog);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			cwd: dir,
			env: { PATH: process.env.PATH ?? "", VERSION: version, RUNNER_TEMP: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		let notes: string | null = null;
		try {
			notes = readFileSync(join(dir, "release-notes.md"), "utf8");
		} catch {
			notes = null;
		}
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
			notes,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const CHANGELOG = `# Changelog

## [0.11.0] - 2026-07-27

### Added
- A thing.

## [0.10.0] - 2026-07-01

### Added
- An older thing.
`;

describe("a missing CHANGELOG section is fatal", () => {
	test("a present section is written out as the release notes", () => {
		const r = extractNotes("0.11.0", CHANGELOG);
		expect(r.exitCode).toBe(0);
		expect(r.notes).toContain("A thing.");
		// The next version's section must not bleed in.
		expect(r.notes).not.toContain("An older thing.");
	});

	test("an absent section fails the release instead of auto-generating notes", () => {
		const r = extractNotes("0.12.0", CHANGELOG);
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
		expect(r.output).toContain("no '## [0.12.0]' section");
	});

	test("a present but empty section is treated as absent", () => {
		const r = extractNotes(
			"0.11.0",
			"# Changelog\n\n## [0.11.0] - 2026-07-27\n\n## [0.10.0]\n- x\n",
		);
		expect(r.exitCode).toBe(1);
	});

	test("the release step has no --generate-notes fallback left", () => {
		expect(stepScript("release", "Create GitHub release")).not.toContain("--generate-notes");
	});
});

// The merge queue authenticates with a GitHub App installation token minted
// per run (warren-2565 retired the static AUTO_MERGE_PAT after it expired
// silently). App private keys carry no expiry, so the heartbeat is a mint
// attempt: if the credential is dead, the mint step fails and the sibling
// job goes red without blocking the release.
describe("auto-merge app credential heartbeat", () => {
	test("runs as a sibling job so a dead credential is visible but never blocks a release", () => {
		const job = loadRelease().jobs?.["app-heartbeat"];
		expect(job).toBeDefined();
		// No `needs` edge in either direction: the release itself is cut with
		// github.token and is unaffected by the app credential.
		expect(job?.needs).toBeUndefined();
		expect(loadRelease().jobs?.deploy?.needs).toBe("release");
	});

	test("the heartbeat mints a token from the app id and private key", () => {
		const steps = releaseSteps("app-heartbeat");
		const mint = steps.find((s) => s.uses?.startsWith("actions/create-github-app-token@"));
		expect(mint).toBeDefined();
		expect(mint?.with?.["app-id"]).toMatch(/^\$\{\{ vars\.AUTO_MERGE_APP_ID \}\}$/);
		expect(mint?.with?.["private-key"]).toMatch(
			/^\$\{\{ secrets\.AUTO_MERGE_APP_PRIVATE_KEY \}\}$/,
		);
	});

	test("no workflow still authenticates with the retired AUTO_MERGE_PAT", () => {
		for (const file of ["auto-merge.yml", "bundle-size-autoheal.yml", "release.yml"]) {
			const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
			expect(raw).not.toContain("secrets.AUTO_MERGE_PAT");
		}
	});

	test("every consumer of the app credential names the same variable and secret", () => {
		for (const file of ["auto-merge.yml", "bundle-size-autoheal.yml", "release.yml"]) {
			const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
			expect(raw).toContain("vars.AUTO_MERGE_APP_ID");
			expect(raw).toContain("secrets.AUTO_MERGE_APP_PRIVATE_KEY");
		}
	});
});
