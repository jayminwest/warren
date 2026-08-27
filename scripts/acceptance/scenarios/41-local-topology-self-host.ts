/**
 * Scenario 41 — local-topology self-host path, end to end (warren-0f18,
 * plan pl-3007 step 12, acceptance criterion 5).
 *
 * The self-host path a new operator lands on: warren booted under the
 * DEFAULT local runtime, dispatching through the INTERNALIZED sandbox —
 * LocalProvider's in-process engine (warren-413d): warren-side worktree
 * materialization, warren-owned bwrap profile (src/sandbox/), host-side
 * drive loop, per-run writable $HOME bound SEPARATE from the workspace.
 * No burrow daemon on the spawn path. This scenario is the nightly pin
 * for that path (the runner needs bubblewrap + user namespaces, so it
 * rides acceptance:nightly, not PR CI).
 *
 * Stub injection pattern for the internalized path: the claude-code
 * adapter's buildSpawnCommand execs the bare name `claude`, resolved
 * inside bwrap via the profile's probed toolchain dirs
 * (src/runtime/local/profile.ts). The scenario prepends a shim dir
 * holding `claude` (lib/stub-agent/claude-code-path-shim.sh) to the
 * booted warren's PATH — no domain-code seam, no real Anthropic call.
 *
 * Assertions:
 *
 *   1. POST /projects clones + registers on a per-scenario warren booted
 *      with WARREN_RUNTIME=local.
 *   2. A committing run (prompt carries `closeseed ah-stub-1`, so the
 *      shim commits) reaches terminal `succeeded` and reap PUSHES the
 *      workspace branch: refs/heads/warren/<runId> resolves in the
 *      fixture repo.
 *   3. FALSIFICATION (warren-c865): a run whose agent makes NO commit
 *      reaches terminal `succeeded` with failureReason null — NOT failed
 *      with dropped_commit. The stub's harness state lands in the
 *      per-run $HOME, not the worktree, so reap classifies the empty
 *      push as `noChanges` (observed on the `reap.empty_push` event).
 *      Before the c865 fix this run failed dropped_commit because
 *      harness scratch dirtied the worktree.
 */

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { collectRunEvents, waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly failureReason: string | null;
}

interface EventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

// The fixture's one known seed (KNOWN_SEED_ID in lib/fixtures.ts — not
// re-exported on ctx), same mechanism scenario 26/40 rely on.
const COMMIT_PROMPT = "scenario-41 local topology — closeseed ah-stub-1";
const NO_COMMIT_PROMPT = "scenario-41 local topology — observe only, make no changes";
// bwrap + cgroup setup on a loaded nightly runner is slower than the
// in-proc stub path suggests; 26/40's 60s brushed the ceiling there.
const RUN_DEADLINE_MS = 120_000;

/** Install the PATH shim: `<dir>/claude` = the stub agent script, executable. */
async function installClaudeShim(shimDir: string): Promise<void> {
	await mkdir(shimDir, { recursive: true });
	const source = new URL("../lib/stub-agent/claude-code-path-shim.sh", import.meta.url).pathname;
	const target = join(shimDir, "claude");
	await copyFile(source, target);
	await chmod(target, 0o755);
}

export const scenario: Scenario = {
	id: "41",
	title:
		"Local-topology self-host — internalized sandbox dispatch reaches succeeded, branch pushed, and a no-commit run does NOT fail dropped_commit (warren-c865 falsification)",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-41-"));
		const shimDir = join(scenarioRoot, "shim-bin");
		await installClaudeShim(shimDir);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath: ctx.fixtures.gitConfigPath,
				extraEnv: {
					// Pin the runtime selection under test, even though `local`
					// is the boot default today.
					WARREN_RUNTIME: "local",
					// The whole stub pattern: the internalized engine execs the
					// bare name `claude`; the shim dir wins resolution both on
					// the host (Bun.which probe) and inside bwrap (profile PATH).
					PATH: `${shimDir}:${process.env.PATH ?? ""}`,
					// Dispatch-time credential delivery is best-effort, but a
					// present key keeps the run on the exact production code
					// path; the shim never reads it.
					ANTHROPIC_API_KEY: "warren-acceptance-stub",
				},
			});
			ctx.logger.info(`scenario-41: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// === 1. Register the sample project ===
			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
			});
			assertEqual(
				project.gitUrl,
				ctx.fixtures.sampleProjectGitUrl,
				"project row keeps the sample fixture clone URL",
			);

			// === 2. Committing run: dispatch → succeeded → branch pushed ===
			const committed = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
				body: { agent: "claude-code", project: project.id, prompt: COMMIT_PROMPT },
			});
			assertEqual(committed.run.state, "queued", "committing run starts queued");
			const commitTerminal = await waitForRunTerminal(http, committed.run.id, RUN_DEADLINE_MS);
			assertEqual(
				commitTerminal.state,
				"succeeded",
				`committing run reaches terminal 'succeeded' (got '${commitTerminal.state}', failureReason=${commitTerminal.failureReason ?? "<null>"})`,
			);
			assertEqual(commitTerminal.failureReason, null, "committing run carries no failureReason");

			const runBranch = `warren/${committed.run.id}`;
			const branchSha = execFileSync(
				"git",
				["-C", ctx.fixtures.sampleProjectPath, "rev-parse", `refs/heads/${runBranch}`],
				{ encoding: "utf8" },
			).trim();
			assertTrue(
				/^[0-9a-f]{40}$/.test(branchSha),
				`run branch ${runBranch} was pushed to the fixture repo (rev-parse → ${branchSha})`,
			);

			// === 3. Falsification: a no-commit run must NOT fail dropped_commit ===
			const noCommit = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
				body: { agent: "claude-code", project: project.id, prompt: NO_COMMIT_PROMPT },
			});
			const noCommitTerminal = await waitForRunTerminal(http, noCommit.run.id, RUN_DEADLINE_MS);
			assertEqual(
				noCommitTerminal.state,
				"succeeded",
				`no-commit run reaches terminal 'succeeded' (got '${noCommitTerminal.state}', failureReason=${noCommitTerminal.failureReason ?? "<null>"}) — pre-warren-c865 this failed dropped_commit because harness state dirtied the worktree`,
			);
			assertEqual(
				noCommitTerminal.failureReason,
				null,
				"no-commit run carries no failureReason (dropped_commit would mean the $HOME/worktree separation regressed)",
			);

			const events = await collectRunEvents<EventRow>(http, noCommit.run.id);
			const emptyPush = events.find((e) => e.kind === "reap.empty_push");
			if (emptyPush === undefined) {
				throw new AcceptanceError(
					`run ${noCommit.run.id}: event stream missing 'reap.empty_push'; saw kinds=[${events.map((e) => e.kind).join(", ")}]`,
				);
			}
			assertEqual(
				emptyPush.payload?.noChanges,
				true,
				"reap.empty_push classifies the no-commit run as noChanges (clean tree, zero commits)",
			);

			ctx.logger.info("scenario-41: local-topology self-host path verified");
		} finally {
			await handle?.stop();
		}
	},
};
