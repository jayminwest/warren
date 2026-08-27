/**
 * Scenario 42 — the one-line self-host claim, falsified end to end
 * (warren-1a5a, plan pl-3007 phase-4 exit pin).
 *
 * The headline: on a fresh host, ONE `docker run` with exactly two
 * secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN), NO security_opt flags, NO
 * cap_add, and NO operator token boots warren, mints the operator token
 * on first boot, and dispatches a run that reaches terminal `succeeded`
 * with the workspace branch pushed.
 *
 * How the scenario falsifies each clause:
 *
 *   1. FRESH HOST — the container gets a brand-new bind-mounted data
 *      dir, so the first-boot mint path (warren-ef6e) is live.
 *   2. ONE DOCKER RUN — warren boots via `docker run`, not compose. The
 *      argv below carries NO `--security-opt` and NO `--cap-add`. Under
 *      WARREN_RUNTIME=docker (warren-3732) the container boundary is the
 *      sandbox, so the four bwrap flags the `local` topology needs are
 *      genuinely unnecessary — this is the claim under test.
 *   3. TWO SECRETS — the env block sets ANTHROPIC_API_KEY + GITHUB_TOKEN
 *      and nothing secret-shaped beside them. WARREN_API_TOKEN is
 *      deliberately UNSET, so boot must mint one.
 *   4. MINT OBSERVED — the scenario scrapes `docker logs` for the
 *      pino row carrying `mintedOperatorToken` (printed exactly once),
 *      then uses THAT token against the API.
 *   5. DISPATCH SUCCEEDS — the run drives the deterministic stub
 *      claude-code shim (lib/stub-agent/claude-code-path-shim.sh) baked
 *      into a local agent image, so no real provider spend. The shim's
 *      `closeseed` knob commits, reap pushes `warren/<runId>` to the
 *      fixture repo, and the scenario rev-parses the ref.
 *
 * Harness plumbing that is NOT part of the operator claim (each flagged
 * at the argv site): the docker socket + CLI mounts the docker topology
 * requires by design, the path-parity data-dir mount, and the fixture
 * mounts that keep the run hermetic. The scenario builds its own tiny
 * fixture repo so it runs in BOTH harness modes.
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForHealthz } from "../lib/poll.ts";
import {
	containerLogs,
	dockerAvailable,
	dockerOrThrow,
	extractMintedToken,
	mintLineCount,
	runDocker,
} from "../lib/self-host-docker.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE_IMAGE = "warren-acceptance-selfhost:local";
const AGENT_IMAGE = "warren-acceptance-selfhost-agent:local";
const CONTAINER_NAME = "warren-acceptance-42";
const COMMIT_PROMPT = "scenario-42 one-liner — closeseed ah-stub-1";
const HEALTHZ_WAIT_MS = 120_000;
const RUN_DEADLINE_MS = 180_000;

interface ProjectRow {
	readonly id: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly failureReason: string | null;
}

/** Build the tiny fixture: one git repo + a git-config insteadOf rewrite. */
async function buildOwnFixtures(root: string): Promise<{
	readonly projectPath: string;
	readonly gitUrl: string;
	readonly gitConfigPath: string;
}> {
	const projectPath = join(root, "sample-project");
	await mkdir(projectPath, { recursive: true });
	const git = (args: readonly string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=acceptance-42", "-c", "user.email=a42@warren.invalid", ...args],
			{ cwd: projectPath, encoding: "utf8" },
		);
	git(["init", "--initial-branch=main"]);
	await writeFile(join(projectPath, "README.md"), "# scenario-42 fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "init"]);
	const gitUrl = "https://github.com/warren-acceptance-42/selfhost-sample.git";
	const gitConfigPath = join(root, "git-config");
	await writeFile(
		gitConfigPath,
		`[url "${projectPath}"]\n\tinsteadOf = ${gitUrl}\n[init]\n\tdefaultBranch = main\n`,
	);
	return { projectPath, gitUrl, gitConfigPath };
}

/** Build the stub agent image: control-plane base + shim as `claude`. */
async function buildImages(root: string): Promise<void> {
	await dockerOrThrow(
		["build", "-t", BASE_IMAGE, "-f", "Dockerfile", REPO_ROOT],
		"base image build",
	);
	const agentCtx = join(root, "agent-image");
	await mkdir(agentCtx, { recursive: true });
	const shim = new URL("../lib/stub-agent/claude-code-path-shim.sh", import.meta.url).pathname;
	const shimTarget = join(agentCtx, "claude");
	await writeFile(shimTarget, await readFile(shim, "utf8"), { mode: 0o755 });
	await writeFile(
		join(agentCtx, "Dockerfile"),
		[
			`FROM ${BASE_IMAGE}`,
			"COPY claude /usr/local/bin/claude",
			"RUN chmod 755 /usr/local/bin/claude",
			// argv[0] must resolve as the bare `claude` name, so the
			// supervisor ENTRYPOINT of the base image cannot survive.
			'ENTRYPOINT ["/usr/bin/env"]',
			"",
		].join("\n"),
	);
	await dockerOrThrow(["build", "-t", AGENT_IMAGE, agentCtx], "stub agent image build");
}

export const scenario: Scenario = {
	id: "42",
	title:
		"One-line self-host — one docker run, two secrets, no security flags, first-boot mint, dispatch succeeds, branch pushed",
	modes: ["in-proc", "container"],
	async run(ctx) {
		if (!(await dockerAvailable())) {
			skipScenario("docker daemon not reachable — scenario 42 needs docker on the host");
		}
		const dockerBin = Bun.which("docker");
		if (dockerBin === null) skipScenario("docker CLI not on PATH");

		// Keep bind sources under the home directory, which Docker Desktop and
		// Colima share with their Linux VM by default. macOS tmpdir() lives under
		// /var/folders; a remote daemon can accept that source path yet mount an
		// empty VM-local directory, so persisted state never reaches the host
		// directory the assertions read (warren-15f0).
		const root = await mkdtemp(join(homedir(), ".warren-acceptance-42-"));
		// mkdtemp creates 0700, but the sibling agent container intentionally
		// runs as uid 1000 and must traverse this host path to its workspace.
		await chmod(root, 0o755);
		const dataDir = join(root, "data");
		let booted = false;
		try {
			const fixtures = await buildOwnFixtures(root);
			await mkdir(dataDir, { recursive: true });
			await buildImages(root);

			// The control-plane image is Linux. A host macOS docker binary cannot
			// execute there, so copy the CLI out of Docker's Linux VM. Linux hosts
			// can use their native CLI directly. Mount the executable from the
			// shared data root so both Docker Desktop and Colima can see it.
			const dockerExecutable = join(dataDir, "docker");
			if (process.platform === "linux") {
				await writeFile(dockerExecutable, await readFile(await realpath(dockerBin)), {
					mode: 0o755,
				});
			} else {
				const copied = await runDocker([
					"run",
					"--rm",
					"-v",
					`${dataDir}:/acceptance-data`,
					"docker:cli",
					"sh",
					"-c",
					"cp /usr/local/bin/docker /acceptance-data/docker && chmod 755 /acceptance-data/docker",
				]);
				if (copied.exitCode !== 0) {
					throw new AcceptanceError(
						`could not stage the Linux docker CLI: ${copied.stderr.trim()}`,
					);
				}
			}

			// === THE ONE-LINER (steps 1–3 of the claim) ===
			// No --security-opt, no --cap-add, no WARREN_API_TOKEN. Only two
			// secrets on the env. The remaining flags are harness plumbing:
			//   - socket + CLI mounts: the docker topology's documented
			//     requirement (docs/design/runtime-docker-provider.md),
			//   - data-dir bind at the SAME absolute path: path parity, so
			//     sibling agent containers resolve the workspace host-side,
			//   - fixture mounts + GIT_CONFIG_GLOBAL: keep clone/push
			//     hermetic (a fake github URL rewritten to a local path),
			//   - two port publishes: 8080 must forward on the host so the
			//     agent container's host-gateway callback URL resolves, and
			//     127.0.0.1:8080 is also the scenario's own API endpoint.
			const runArgs = [
				"run",
				"-d",
				"--name",
				CONTAINER_NAME,
				"-p",
				"8080:8080",
				"-v",
				`${dataDir}:${dataDir}`,
				"-v",
				"/var/run/docker.sock:/var/run/docker.sock",
				"-v",
				`${dockerExecutable}:/usr/bin/docker:ro`,
				"-v",
				`${fixtures.projectPath}:${fixtures.projectPath}`,
				"-v",
				`${fixtures.gitConfigPath}:${fixtures.gitConfigPath}:ro`,
				"-e",
				"ANTHROPIC_API_KEY=warren-acceptance-stub",
				"-e",
				"GITHUB_TOKEN=warren-acceptance-stub",
				"-e",
				"WARREN_RUNTIME=docker",
				"-e",
				`WARREN_DOCKER_AGENT_IMAGE=${AGENT_IMAGE}`,
				"-e",
				`WARREN_DATA_DIR=${dataDir}`,
				"-e",
				`GIT_CONFIG_GLOBAL=${fixtures.gitConfigPath}`,
				"-e",
				"GIT_AUTHOR_NAME=Warren Acceptance",
				"-e",
				"GIT_AUTHOR_EMAIL=acceptance@warren.invalid",
				"-e",
				"GIT_COMMITTER_NAME=Warren Acceptance",
				"-e",
				"GIT_COMMITTER_EMAIL=acceptance@warren.invalid",
				"-e",
				"WARREN_DISABLE_UI=1",
				"-e",
				"WARREN_LOG_LEVEL=info",
				"-e",
				"CANOPY_REPO_URL=",
				BASE_IMAGE,
			];
			await dockerOrThrow(runArgs, "fresh-host docker run");
			booted = true;

			const warrenUrl = "http://127.0.0.1:8080";
			await waitForHealthz(warrenUrl, HEALTHZ_WAIT_MS).catch(async (err) => {
				const logs = await containerLogs(CONTAINER_NAME).catch(() => "<no logs>");
				throw new AcceptanceError(
					`fresh-host container never went healthy: ${String(err)}\n--- logs ---\n${logs}`,
				);
			});

			// === Step 4: first-boot mint observed in the logs ===
			const logs = await containerLogs(CONTAINER_NAME);
			const token = extractMintedToken(logs);
			assertEqual(
				mintLineCount(logs),
				1,
				"the minted operator token prints exactly once (warren-ef6e)",
			);
			const persisted = await readFile(join(dataDir, "operator-token"), "utf8");
			assertTrue(
				persisted.includes(token),
				"operator-token file under the data dir persists the minted token",
			);

			// The minted token is real: auth rejects without it, accepts it.
			const unauth = await fetch(`${warrenUrl}/agents`);
			assertEqual(unauth.status, 401, "GET /agents returns 401 without the minted token");
			const http = new WarrenHttp({ baseUrl: warrenUrl, token });

			// === Step 5: project add → dispatch → succeeded → pushed ===
			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: fixtures.gitUrl },
			});
			const dispatched = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
				body: { agent: "claude-code", project: project.id, prompt: COMMIT_PROMPT },
			});
			const terminal = await waitForRunTerminal(http, dispatched.run.id, RUN_DEADLINE_MS);
			if (terminal.state !== "succeeded") {
				const events = await http.request("GET", `/runs/${dispatched.run.id}/events`);
				const diagnostics = await events.text();
				throw new AcceptanceError(
					`run reaches terminal 'succeeded' (got '${terminal.state}', failureReason=${terminal.failureReason ?? "<null>"})\n--- run events ---\n${diagnostics.slice(-4000)}`,
				);
			}
			assertEqual(terminal.failureReason, null, "run carries no failureReason");

			const branchSha = execFileSync(
				"git",
				["-C", fixtures.projectPath, "rev-parse", `refs/heads/warren/${dispatched.run.id}`],
				{ encoding: "utf8" },
			).trim();
			assertTrue(
				/^[0-9a-f]{40}$/.test(branchSha),
				`run branch warren/${dispatched.run.id} pushed to the fixture repo (rev-parse → ${branchSha})`,
			);

			ctx.logger.info("scenario-42: one-line self-host claim verified end to end");
		} finally {
			if (booted) {
				await dockerOrThrow(["rm", "-f", CONTAINER_NAME], "container teardown").catch(
					() => undefined,
				);
			}
			// Fixed image tags keep the daemon clean across reruns; removal is
			// best-effort because the layer cache survives tag deletion.
			for (const tag of [AGENT_IMAGE, BASE_IMAGE]) {
				await dockerOrThrow(["rmi", "-f", tag], "image teardown").catch(() => undefined);
			}
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
		}
	},
};
