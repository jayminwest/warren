/**
 * Fixture builder for the acceptance harness.
 *
 * Builds two on-disk git repos warren can clone, plus a `git-config`
 * file that rewrites their fake `https://github.com/...` URLs to local
 * paths via `[url "...".insteadOf]`. Setting `GIT_CONFIG_GLOBAL` to
 * that file (the in-proc launcher already does) makes warren's
 * `git clone https://github.com/warren-acceptance/sample.git` resolve
 * to the local fixture transparently — no network, no production code
 * change to warren's URL parser.
 *
 * The canopy library is built by shelling to the `cn` CLI installed on
 * the harness's PATH. That keeps the schema authored by canopy itself,
 * so a canopy version bump doesn't silently break the fixture.
 *
 * The sample project carries:
 *   - `burrow.toml` — the `[sandbox]` section the local profile still
 *     reads (src/runtime/local/profile.ts). The legacy `[env]`
 *     envPassthrough list and `[[agents]]` registry block left with the
 *     stub-shell burrow runtime (warren-dc19): dispatch resolves the
 *     agent through the WARREN_SEED_AGENTS_FILE payload + PATH shims,
 *     and the knob contract is prompt-driven ([sleep_ms]/[mulch_*]/
 *     [seed_*] — see lib/stub-agent/claude-code-path-shim.sh).
 *   - `README.md` — so `git commit` has at least one tracked file
 *     warren's git clone can resolve a default branch from.
 *
 * Cleanup: the in-proc launcher removes `tmpRoot` recursively on stop.
 * Builders here just write files; lifecycle is the launcher's problem.
 */
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureRoots {
	readonly tmpRoot: string;
}

export interface BuiltFixtures {
	readonly canopyRepoPath: string;
	readonly canopyRepoUrl: string;
	readonly sampleProjectPath: string;
	readonly sampleProjectGitUrl: string;
	readonly sampleProjectName: string;
	readonly stubAgentName: string;
	readonly knownSeedId: string;
	readonly knownSeedTitle: string;
	readonly knownMulchDomain: string;
	readonly knownMulchRecordId: string;
	/**
	 * Directory holding the `claude` PATH-shim stub
	 * (lib/stub-agent/claude-code-path-shim.sh). The harness prepends it
	 * to PATH before booting warren so the internalized local engine's
	 * claude-code adapter execs the deterministic stub instead of a real
	 * claude binary (warren-dc19 — replaces the retired stub-shell burrow
	 * runtime for scenarios 05/07/09/10).
	 */
	readonly claudeShimBinDir: string;
	readonly gitConfigPath: string;
	/**
	 * Path to a JSON array of AgentDefinition objects the booted warren
	 * seeds via WARREN_SEED_AGENTS_FILE (warren-e376). Carries the
	 * `stub-shell` definition now that POST /agents/refresh is gone
	 * (pl-3a79) and the registry seeds on boot only.
	 */
	readonly seedAgentsFilePath: string;
	/**
	 * PATH-shim directory holding the stub `pi` and `claude` binaries
	 * (warren-ea0a — the internalized engine execs the bare names, so a
	 * shim dir on the booted warren's PATH is the deterministic-agent
	 * injection point, replacing the burrow-side runtime registry).
	 */
	readonly shimBinDir: string;
}

const FAKE_CANOPY_OWNER = "warren-acceptance";
const FAKE_CANOPY_REPO = "canopy";
const FAKE_PROJECT_OWNER = "warren-acceptance";
const FAKE_PROJECT_REPO = "sample";
const STUB_AGENT_NAME = "stub-shell";
const KNOWN_SEED_ID = "ah-stub-1";
const KNOWN_SEED_TITLE = "stub seed closed by acceptance harness";
const KNOWN_MULCH_DOMAIN = "acceptance";
const KNOWN_MULCH_RECORD_ID = "mx-acceptance-stub-1";

export async function buildFixtures(roots: FixtureRoots): Promise<BuiltFixtures> {
	const fixturesRoot = join(roots.tmpRoot, "fixtures");
	const canopyRepoPath = join(fixturesRoot, "canopy-source");
	const sampleProjectPath = join(fixturesRoot, "sample-source");
	const gitConfigPath = join(roots.tmpRoot, "git-config");

	await mkdir(canopyRepoPath, { recursive: true });
	await mkdir(sampleProjectPath, { recursive: true });

	const canopyRepoUrl = `https://github.com/${FAKE_CANOPY_OWNER}/${FAKE_CANOPY_REPO}.git`;
	const sampleProjectGitUrl = `https://github.com/${FAKE_PROJECT_OWNER}/${FAKE_PROJECT_REPO}.git`;

	await buildCanopyRepo(canopyRepoPath);
	await buildSampleProject(sampleProjectPath);
	const seedAgentsFilePath = join(fixturesRoot, "stub-agents.json");
	await buildSeedAgentsFile(seedAgentsFilePath);
	const shimBinDir = join(fixturesRoot, "shim-bin");
	await buildShimBin(shimBinDir);
	const claudeShimBinDir = join(fixturesRoot, "bin");
	await buildPathShims(claudeShimBinDir);
	await writeGitConfigRedirects(gitConfigPath, [
		{ fakeUrl: canopyRepoUrl, localPath: canopyRepoPath },
		{ fakeUrl: sampleProjectGitUrl, localPath: sampleProjectPath },
		// scp-style git@github.com:owner/name.git form must redirect too,
		// since warren accepts both shapes.
		{
			fakeUrl: `git@github.com:${FAKE_CANOPY_OWNER}/${FAKE_CANOPY_REPO}.git`,
			localPath: canopyRepoPath,
		},
		{
			fakeUrl: `git@github.com:${FAKE_PROJECT_OWNER}/${FAKE_PROJECT_REPO}.git`,
			localPath: sampleProjectPath,
		},
	]);

	return {
		canopyRepoPath,
		canopyRepoUrl,
		sampleProjectPath,
		sampleProjectGitUrl,
		sampleProjectName: FAKE_PROJECT_REPO,
		stubAgentName: STUB_AGENT_NAME,
		knownSeedId: KNOWN_SEED_ID,
		knownSeedTitle: KNOWN_SEED_TITLE,
		knownMulchDomain: KNOWN_MULCH_DOMAIN,
		knownMulchRecordId: KNOWN_MULCH_RECORD_ID,
		claudeShimBinDir,
		gitConfigPath,
		seedAgentsFilePath,
		shimBinDir,
	};
}

/**
 * Install the PATH shims the internalized engine resolves by bare name
 * (warren-0f18 / warren-ea0a): `claude` and `pi`. The sandbox profile
 * probes each name via Bun.which against the booted warren's PATH and
 * binds the shim dir into the sandbox.
 */
async function buildShimBin(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const shims: Array<readonly [string, string]> = [
		["claude", "./stub-agent/claude-code-path-shim.sh"],
		["pi", "./stub-agent/pi-path-shim.sh"],
	];
	// warren-8a6e / warren-dc19: Bun.spawn resolves the bare `bwrap` name
	// against the *sandbox* PATH (toolchain dirs only — see src/sandbox/env.ts),
	// not the host process PATH. The sandbox PATH is built from the bin dir of
	// the resolved agent binary, so bwrap must sit next to `claude`/`pi` in
	// EVERY shim dir the harness may put first on PATH. Without it, every
	// stub run fails spawn_failed with `Executable not found in $PATH: "bwrap"`
	// on hosts that lack a real bubblewrap.
	if (Bun.which("bwrap") === null) {
		shims.push(["bwrap", "./stub-agent/bwrap-shim.sh"]);
	}
	for (const [name, rel] of shims) {
		const source = new URL(rel, import.meta.url).pathname;
		const target = join(dir, name);
		await copyFile(source, target);
		await chmod(target, 0o755);
	}
}

/**
 * Write the WARREN_SEED_AGENTS_FILE payload: the `stub-shell` agent as a
 * warren AgentDefinition. Its `runtime=claude-code` frontmatter resolves
 * the internalized local engine's claude-code adapter (src/runtime/
 * adapters/), whose `claude` binary the harness stubs via the PATH shim
 * (buildPathShims below). `source: "builtin"` lets seedBuiltinAgents
 * upsert on drift across reboots.
 */
async function buildSeedAgentsFile(path: string): Promise<void> {
	const stubAgent = {
		name: STUB_AGENT_NAME,
		version: 1,
		sections: {
			system: STUB_SYSTEM_SECTION,
			burrow_config: STUB_BURROW_CONFIG_SECTION,
		},
		resolvedFrom: ["acceptance:stub-shell"],
		frontmatter: {
			source: "builtin",
			tags: ["agent"],
			description: "Deterministic stub agent for warren acceptance",
			runtime: "claude-code",
		},
	};
	await writeFile(path, `${JSON.stringify([stubAgent], null, 2)}\n`);
}

/**
 * Install the `claude` PATH-shim stub (lib/stub-agent/
 * claude-code-path-shim.sh) into a bin dir the harness prepends to the
 * booted warren's PATH. Warren's internalized local engine execs the
 * bare name `claude` inside its sandbox; profile generation probes it
 * via Bun.which and binds the shim dir in (src/runtime/local/profile.ts).
 */
async function buildPathShims(binDir: string): Promise<void> {
	const shims: Array<readonly [string, string]> = [
		["claude", "./stub-agent/claude-code-path-shim.sh"],
	];
	// Fake bwrap (warren-dc19): the internalized engine spawns agents
	// through `bwrap`, which acceptance hosts may neither ship nor be able
	// to unshare. The shim applies the workspace/home mappings and execs
	// the child — see lib/stub-agent/bwrap-shim.sh. It must live in the
	// SAME bin dir as the claude shim (Bun.spawn resolves the bare `bwrap`
	// against the composed sandbox PATH, which only carries probed
	// toolchain dirs), so install it only when the host has no real bwrap
	// — a nightly runner with bubblewrap keeps the real sandbox.
	if (Bun.which("bwrap") === null) {
		shims.push(["bwrap", "./stub-agent/bwrap-shim.sh"]);
	}
	await mkdir(binDir, { recursive: true });
	for (const [name, relSource] of shims) {
		const source = new URL(relSource, import.meta.url);
		const target = join(binDir, name);
		await copyFile(source, target);
		await chmod(target, 0o755);
	}
}

// The stub agent's two sections, shared between the canopy fixture
// (buildCanopyRepo) and the WARREN_SEED_AGENTS_FILE payload
// (buildSeedAgentsFile) so the two registration paths can't drift apart.
const STUB_BURROW_CONFIG_SECTION = [
	"[sandbox]",
	`network = "restricted"`,
	`allowed_domains = ["github.com", "registry.npmjs.org"]`,
	"",
].join("\n");
const STUB_SYSTEM_SECTION = [
	"You are the warren acceptance stub agent. You only run inside",
	"warren's acceptance harness — never against real user data.",
].join(" ");

async function buildCanopyRepo(repoPath: string): Promise<void> {
	const env = withGitIdentity({ HOME: process.env.HOME ?? "/tmp" });

	await runIn(repoPath, ["git", "init", "--initial-branch=main"], env);
	await runIn(repoPath, ["cn", "init"], env);
	const burrowConfigSection = STUB_BURROW_CONFIG_SECTION;
	const systemSection = STUB_SYSTEM_SECTION;
	await runIn(
		repoPath,
		[
			"cn",
			"create",
			"--name",
			STUB_AGENT_NAME,
			"--tag",
			"agent",
			"--description",
			"Deterministic stub agent for warren acceptance",
			"--section",
			`system=${systemSection}`,
			"--section",
			`burrow_config=${burrowConfigSection}`,
			// Pin the burrow runtime to the declarative stub-shell runtime
			// (the legacy agent.sh honored the [sleep_ms]/[mulch_*]/[seed_*]
			// prompt knobs; the PATH shim carries that contract now).
			// Without this, readRuntimeId() (src/registry/schema.ts)
			// falls back to DEFAULT_RUNTIME_ID="pi", so warren dispatches
			// stub-shell runs onto the pi runtime (pi-agent.sh), which ignores
			// those knobs — completing before cancel can land (scenario 08) and
			// writing no mulch/seeds mirror output (09/10). warren-83b5.
			"--fm",
			`runtime=${STUB_AGENT_NAME}`,
		],
		env,
	);
	// `cn sync` stages and commits .canopy/ if available; fall back to a
	// plain `git add . && git commit` if cn doesn't expose it.
	try {
		await runIn(repoPath, ["cn", "sync"], env);
	} catch {
		await runIn(repoPath, ["git", "add", "."], env);
		await runIn(repoPath, ["git", "commit", "-m", "init: canopy fixture"], env);
	}
}

async function buildSampleProject(repoPath: string): Promise<void> {
	const env = withGitIdentity({ HOME: process.env.HOME ?? "/tmp" });

	await runIn(repoPath, ["git", "init", "--initial-branch=main"], env);

	// Project's burrow.toml — only the `[sandbox]` section survives the
	// burrow excision: the local profile reads it for network/allowed
	// domains (src/runtime/local/profile.ts). The `[env]` WARREN_STUB_*
	// passthrough list and the `[[agents]]` stub-shell registry entry
	// were burrow-runtime concerns and are gone with it (warren-75dd).
	const burrowToml = [
		"# warren acceptance — sample project burrow.toml",
		"[project]",
		`name = "${FAKE_PROJECT_REPO}"`,
		`default_branch = "main"`,
		"",
		"[sandbox]",
		`network = "restricted"`,
		`allowed_domains = ["github.com", "registry.npmjs.org"]`,
		"",
	].join("\n");
	await writeFile(join(repoPath, "burrow.toml"), burrowToml);

	await mkdir(join(repoPath, "tools"), { recursive: true });

	// Pi-shaped stub agent script (warren-17a4) — emits pi RPC JSONL with
	// `turn_end` usage so scenario 16 can assert non-null cost/token
	// columns after the run completes. Registered as the `pi` runtime in
	// the harness under the pi PATH shim (warren-ea0a).
	const harnessPiScript = new URL("./stub-agent/pi-agent.sh", import.meta.url);
	const targetPiScript = join(repoPath, "tools", "pi-stub-agent.sh");
	await copyFile(harnessPiScript, targetPiScript);

	// Claude-code-shaped stub agent script (warren-87f9) — emits
	// stream-json with a terminal `result` envelope carrying
	// `total_cost_usd` + `usage.*_tokens` so scenario 17 can assert
	// non-null cost/token columns after the run completes. Registered as
	// the harness under the claude PATH shim (warren-0f18).
	const harnessClaudeScript = new URL("./stub-agent/claude-code-agent.sh", import.meta.url);
	const targetClaudeScript = join(repoPath, "tools", "claude-code-stub-agent.sh");
	await copyFile(harnessClaudeScript, targetClaudeScript);

	// Seed the project's .seeds/issues.jsonl with one open seed the stub
	// agent will close — gives reap's seeds-close-mirror sub-step
	// something to mirror.
	const initialSeed = `{"id":"${KNOWN_SEED_ID}","title":"${KNOWN_SEED_TITLE}","status":"open","type":"task","priority":3,"createdAt":"2026-05-08T00:00:00.000Z","updatedAt":"2026-05-08T00:00:00.000Z"}\n`;
	await mkdir(join(repoPath, ".seeds"), { recursive: true });
	await writeFile(join(repoPath, ".seeds", "issues.jsonl"), initialSeed);

	// Empty .mulch/ — reap creates the expertise dir on first append.
	await mkdir(join(repoPath, ".mulch", "expertise"), { recursive: true });
	await writeFile(join(repoPath, ".mulch", ".gitkeep"), "");

	// README so the initial commit has more than dotfiles, and so any
	// post-clone "what is this repo?" inspection is self-explanatory.
	const readme = [
		"# warren acceptance sample project",
		"",
		"This repo is a fixture used by warren's acceptance harness.",
		"Runs dispatch against the boot-seeded `stub-shell` agent, which",
		"the harness PATH shims drive for deterministic, no-network runs.",
		"",
	].join("\n");
	await writeFile(join(repoPath, "README.md"), readme);

	await runIn(repoPath, ["chmod", "+x", "tools/pi-stub-agent.sh"], env);
	await runIn(repoPath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(repoPath, ["git", "add", "."], env);
	await runIn(repoPath, ["git", "commit", "-m", "init: sample project fixture"], env);
}

async function writeGitConfigRedirects(
	gitConfigPath: string,
	redirects: ReadonlyArray<{ fakeUrl: string; localPath: string }>,
): Promise<void> {
	// No [user] section here on purpose (warren-9f70): a global [user]
	// can stick to a project clone's local .git/config under the wrong
	// conditions and leak `acceptance@warren.invalid` into agent commits
	// during real runs. Fixture and scenario git invocations supply
	// identity via GIT_AUTHOR_* / GIT_COMMITTER_* env vars
	// (see withGitIdentity below and inproc.ts), which is sufficient
	// for `git commit` without any local or global [user] entry.
	const lines: string[] = ["[init]", "\tdefaultBranch = main", "[safe]", "\tdirectory = *", ""];
	for (const { fakeUrl, localPath } of redirects) {
		lines.push(`[url "${localPath}"]`);
		lines.push(`\tinsteadOf = ${fakeUrl}`);
	}
	await writeFile(gitConfigPath, `${lines.join("\n")}\n`);
}

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(
			`fixture command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

function withGitIdentity(extra: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
	for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
	return out;
}

// Re-export anchor constants so scenarios can build deterministic
// expectations off the same names the fixture emits.
export const FIXTURE_CONSTANTS = {
	canopyOwner: FAKE_CANOPY_OWNER,
	canopyRepo: FAKE_CANOPY_REPO,
	projectOwner: FAKE_PROJECT_OWNER,
	projectRepo: FAKE_PROJECT_REPO,
	stubAgentName: STUB_AGENT_NAME,
	knownSeedId: KNOWN_SEED_ID,
	knownSeedTitle: KNOWN_SEED_TITLE,
	knownMulchDomain: KNOWN_MULCH_DOMAIN,
	knownMulchRecordId: KNOWN_MULCH_RECORD_ID,
} as const;
