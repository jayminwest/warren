import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-8b5f: the release job must be at least as strict as CI,
// must refuse to publish a release with no curated CHANGELOG section, and must
// keep a heartbeat on AUTO_MERGE_PAT — the secret whose silent expiry stops
// merges to main and therefore stops releases, with no failed run to notice.
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

/**
 * Execute the AUTO_MERGE_PAT heartbeat shell against a stubbed `curl` that
 * replays a canned response-header block.
 */
function runHeartbeat(opts: { pat: string; headers: string }): {
	exitCode: number;
	output: string;
} {
	const script = stepScript("pat-heartbeat", "Check AUTO_MERGE_PAT");
	const dir = mkdtempSync(join(tmpdir(), "warren-pat-heartbeat-"));
	try {
		const stub = join(dir, "curl");
		writeFileSync(stub, `#!/bin/sh\ncat <<'EOF'\n${opts.headers}\nEOF\n`);
		chmodSync(stub, 0o755);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			env: {
				PATH: `${dir}:${process.env.PATH ?? ""}`,
				PAT: opts.pat,
				WARN_DAYS: "14",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A response-header block whose token expires `days` from now. */
function headersExpiringIn(days: number): string {
	const at = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
	return `HTTP/2 200\ncontent-type: application/json\ngithub-authentication-token-expiration: ${at} 07:00:00 UTC`;
}

describe("AUTO_MERGE_PAT heartbeat", () => {
	test("runs as a sibling job so a dead PAT is visible but never blocks a release", () => {
		const job = loadRelease().jobs?.["pat-heartbeat"];
		expect(job).toBeDefined();
		// No `needs` edge in either direction: the release itself is cut with
		// github.token and is unaffected by the PAT.
		expect(job?.needs).toBeUndefined();
		expect(loadRelease().jobs?.deploy?.needs).toBe("release");
	});

	test("an unset secret fails", () => {
		const r = runHeartbeat({ pat: "", headers: "HTTP/2 200" });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("AUTO_MERGE_PAT is not configured");
	});

	test("a revoked or expired token is rejected by the API and fails", () => {
		const r = runHeartbeat({ pat: "ghp_x", headers: "HTTP/2 401\ncontent-type: application/json" });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("HTTP 401");
	});

	test("a token past its expiry date fails", () => {
		const r = runHeartbeat({ pat: "ghp_x", headers: headersExpiringIn(-1) });
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
		expect(r.output).toContain("expired on");
	});

	test("a token inside the rotation window warns but passes", () => {
		const r = runHeartbeat({ pat: "ghp_x", headers: headersExpiringIn(3) });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("::warning::");
	});

	test("a healthy token passes quietly", () => {
		const r = runHeartbeat({ pat: "ghp_x", headers: headersExpiringIn(120) });
		expect(r.exitCode).toBe(0);
		expect(r.output).not.toContain("::warning::");
		expect(r.output).toContain("is valid for");
	});

	test("a non-expiring token passes", () => {
		const r = runHeartbeat({ pat: "ghp_x", headers: "HTTP/2 200\ncontent-type: application/json" });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("no expiration date");
	});
});
