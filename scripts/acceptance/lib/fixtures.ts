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
 *   - `burrow.toml` — declares the `stub-shell` agent (SPEC §12.3
 *     declarative AgentConfig) pointing at the bash script the harness
 *     runs on every dispatch.
 *   - `tools/stub-agent.sh` — the deterministic stub committed via
 *     scripts/acceptance/lib/stub-agent/agent.sh.
 *   - `README.md` — so `git commit` has at least one tracked file
 *     warren's git clone can resolve a default branch from.
 *
 * Cleanup: the in-proc launcher removes `tmpRoot` recursively on stop.
 * Builders here just write files; lifecycle is the launcher's problem.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
	/** Path to the stub bash script committed inside the sample project. */
	readonly stubAgentScriptInProject: string;
	readonly gitConfigPath: string;
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
		stubAgentScriptInProject: join(sampleProjectPath, "tools", "stub-agent.sh"),
		gitConfigPath,
	};
}

async function buildCanopyRepo(repoPath: string): Promise<void> {
	const env = withGitIdentity({ HOME: process.env.HOME ?? "/tmp" });

	await runIn(repoPath, ["git", "init", "--initial-branch=main"], env);
	await runIn(repoPath, ["cn", "init"], env);
	const burrowConfigSection = [
		"[sandbox]",
		`network = "restricted"`,
		`allowed_domains = ["github.com", "registry.npmjs.org"]`,
		"",
	].join("\n");
	const systemSection = [
		"You are the warren acceptance stub agent. You only run inside",
		"warren's acceptance harness — never against real user data.",
	].join(" ");
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

	// Project's burrow.toml — declares the stub-shell [[agents]] entry
	// burrow uses to resolve the agentId warren passes on dispatch.
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
		// Forward the four WARREN_STUB_* knobs the agent.sh script reads
		// from the harness env into the sandbox. burrow's resolveEnv()
		// silently drops keys missing from the host env, so scenarios
		// that don't set them (03, 04) are unaffected; scenarios 05/06
		// rely on WARREN_STUB_SLEEP_MS to keep the agent alive across the
		// kill window.
		"[env]",
		`optional = ["WARREN_STUB_SLEEP_MS", "WARREN_STUB_MULCH_DOMAIN", "WARREN_STUB_MULCH_ID", "WARREN_STUB_SEED_ID"]`,
		"",
		"[[agents]]",
		`id = "${STUB_AGENT_NAME}"`,
		`displayName = "Stub Shell (acceptance)"`,
		`command = "bash"`,
		`args = ["./tools/stub-agent.sh", "{{prompt}}"]`,
		`promptDelivery = "arg"`,
		`outputFormat = "raw-text"`,
		`supportsResume = false`,
		`inboxDelivery = "none"`,
		"",
	].join("\n");
	await writeFile(join(repoPath, "burrow.toml"), burrowToml);

	// Stub agent script — copied from the harness's stub-agent dir so
	// edits to scripts/acceptance/lib/stub-agent/agent.sh propagate.
	const harnessStubScript = new URL("./stub-agent/agent.sh", import.meta.url);
	const targetScript = join(repoPath, "tools", "stub-agent.sh");
	await mkdir(dirname(targetScript), { recursive: true });
	await copyFile(harnessStubScript, targetScript);

	// Pi-shaped stub agent script (warren-17a4) — emits pi RPC JSONL with
	// `turn_end` usage so scenario 16 can assert non-null cost/token
	// columns after the run completes. Registered as the `pi` runtime in
	// burrow-with-stub.ts with a custom AgentRuntime whose parseEvents is
	// burrow's parsePiEvents.
	const harnessPiScript = new URL("./stub-agent/pi-agent.sh", import.meta.url);
	const targetPiScript = join(repoPath, "tools", "pi-stub-agent.sh");
	await copyFile(harnessPiScript, targetPiScript);

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
		"It declares the `stub-shell` agent (see `burrow.toml`) which",
		"runs `tools/stub-agent.sh` for deterministic, no-network runs.",
		"",
	].join("\n");
	await writeFile(join(repoPath, "README.md"), readme);

	await runIn(repoPath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(repoPath, ["chmod", "+x", "tools/pi-stub-agent.sh"], env);
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
