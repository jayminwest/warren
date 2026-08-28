/**
 * Scenario 44 — dispatch a run onto an EXISTING branch (warren-326f).
 *
 * The plan pl-096b acceptance criterion:
 *   "an acceptance scenario dispatches run B onto run A's branch and
 *    asserts both commit sets land on one branch."
 *
 * `existingBranch` is the strictly opt-in dispatch field: the run checks
 * out the named head branch and pushes back to it — no composed
 * `warren/run_<id>` branch, no PR. This scenario drives the full loop
 * against the in-proc stack with the stub agent:
 *
 *   1. A `shared/existing-branch` branch is pushed onto the sample
 *      fixture remote (the branch the field REQUIRES to exist — the
 *      fail-closed probe runs before any side effect).
 *   2. Run A dispatches with existingBranch + a seeds-close knob (the
 *      stub agent's commit path) and reaps `succeeded` with the branch
 *      echoed as both `ref` and `targetBranch`, `prUrl` null (the
 *      branch-is-base PR skip).
 *   3. Run B dispatches onto the SAME branch the same way.
 *   4. The shared branch on the fixture remote carries BOTH stub
 *      commits — the two commit sets landed on one branch.
 *   5. The fail-closed guard: dispatching with a branch the remote
 *      does not carry is a 400 BEFORE any run row is created.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly branch: string | null;
	readonly ref: string | null;
	readonly targetBranch: string | null;
	readonly prUrl: string | null;
	readonly failureReason: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

const SHARED_BRANCH = "shared/existing-branch";
const SEED_ID_A = "ah-acceptance-44-a";
const SEED_ID_B = "ah-acceptance-44-b";
const SEED_TS = "2026-06-18T09:00:00.000Z";

export const scenario: Scenario = {
	id: "44",
	title:
		"Existing-branch dispatch — run B lands on run A's branch; missing branch is a fail-closed 400",
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		const project = await ensureSampleProject(http, ctx.fixtures.sampleProjectGitUrl);

		// 1. The shared branch must exist on the push remote BEFORE any
		//    existingBranch dispatch (the field refuses to compose a
		//    workspace onto a branch the remote does not carry).
		await pushSharedBranch(project.localPath);

		// 2. Run A onto the existing branch.
		const runA = await dispatchOnBranch(http, project.id, ctx.fixtures.stubAgentName, SEED_ID_A);
		assertEqual(runA.branch, SHARED_BRANCH, "run A workspace branch is the existing branch");
		assertEqual(runA.ref, SHARED_BRANCH, "run A ref echoes the existing branch");
		assertEqual(runA.targetBranch, SHARED_BRANCH, "run A targetBranch is the existing branch");
		assertEqual(runA.prUrl, null, "run A opens no PR (push-back to the base branch itself)");

		// 3. Run B onto run A's branch.
		const runB = await dispatchOnBranch(http, project.id, ctx.fixtures.stubAgentName, SEED_ID_B);
		assertEqual(runB.branch, SHARED_BRANCH, "run B workspace branch is the existing branch");

		// 4. Both commit sets land on ONE branch on the remote.
		await assertBranchCarriesCommits(project.localPath, [
			`claude-stub: close ${SEED_ID_A}`,
			`claude-stub: close ${SEED_ID_B}`,
		]);

		// 5. Fail closed: a branch absent from the remote is a clean 400
		//    before any run row exists.
		const rejected = await http.expectJson<{ error?: { message?: string } }>(
			"POST",
			"/runs",
			400,
			{
				body: {
					agent: ctx.fixtures.stubAgentName,
					project: project.id,
					prompt: "should never spawn",
					existingBranch: "ghost/does-not-exist",
				},
			},
		);
		const rejectedMessage = rejected.error?.message ?? JSON.stringify(rejected);
		assertTrue(
			rejectedMessage.includes("does not exist on the push remote"),
			`400 body should name the missing branch problem; got ${rejectedMessage}`,
		);
	},
};

async function ensureSampleProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function git(args: readonly string[], cwd: string): Promise<void> {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		throw new AcceptanceError(
			`git ${args.join(" ")} failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`,
		);
	}
}

/**
 * Push the shared branch to the fixture remote (a local path via insteadOf).
 * Forced: re-runs reset the branch to main so the scenario stays idempotent
 * even after run A/B appended their commits on a previous pass. The scenario
 * runner's own env has no insteadOf redirect, so the fixture's local path is
 * used directly (buildFixtures exposes sampleProjectPath for exactly this).
 */
async function pushSharedBranch(sampleProjectPath: string): Promise<void> {
	const workdir = await mkdtemp(join(tmpdir(), "warren-scenario-44-push-"));
	try {
		const seedClone = join(workdir, "seed");
		await git(["clone", "--quiet", sampleProjectPath, seedClone], workdir);
		await git(
			["push", "--force", "origin", `HEAD:refs/heads/${SHARED_BRANCH}`],
			seedClone,
		);
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}

async function dispatchOnBranch(
	http: WarrenHttp,
	projectId: string,
	agentName: string,
	seedId: string,
): Promise<RunRow> {
	const prompt = `[sleep_ms=1500] [seed_id=${seedId}] [seed_ts=${SEED_TS}] scenario-44 existing-branch`;
	const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
		body: { agent: agentName, project: projectId, prompt, existingBranch: SHARED_BRANCH },
	});
	const state = await waitForRunTerminal(http, created.run.id, 30_000);
	const final = await http.expectJson<{ run: RunRow }>(
		"GET",
		`/runs/${encodeURIComponent(created.run.id)}`,
		200,
	);
	if (final.run.state !== "succeeded") {
		throw new AcceptanceError(
			`existing-branch run ${created.run.id} ended '${state}' with failureReason=${final.run.failureReason}; expected succeeded`,
		);
	}
	return final.run;
}

/** Assert the shared branch on the fixture remote carries every given commit subject. */
async function assertBranchCarriesCommits(
	sampleProjectPath: string,
	subjects: readonly string[],
): Promise<void> {
	const workdir = await mkdtemp(join(tmpdir(), "warren-scenario-44-"));
	try {
		const clonePath = join(workdir, "verify");
		await git(["clone", "--quiet", "--branch", SHARED_BRANCH, sampleProjectPath, clonePath], workdir);
		const log = Bun.spawnSync(["git", "log", "--format=%s", "-3"], {
			cwd: clonePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const logOut = log.stdout.toString();
		for (const subject of subjects) {
			assertTrue(logOut.includes(subject), `shared branch log should include '${subject}'; got:\n${logOut}`);
		}
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}
