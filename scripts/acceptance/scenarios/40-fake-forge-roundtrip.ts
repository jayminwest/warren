/**
 * Scenario 40 — FakeForge end-to-end roundtrip (plan pl-d1c9 step 13 /
 * warren-2600): the Forge campaign's FALSIFICATION TEST 1
 * (forge-contract.md §0).
 *
 * A project whose clone URL is owned by FakeForge (`fake://…`) completes
 * dispatch → reap → push → PR with warren booted under `WARREN_FORGE=fake`
 * and NOTHING else special. The claim under test is that the swap forces
 * ZERO domain-code changes: every behavior this scenario asserts flows
 * through the seam (src/forge/) alone. If this scenario ever needs a
 * `src/runs/` / `src/plan-runs/` / `src/triggers/` edit to pass, the
 * abstraction failed — treat that as a finding, not a fix.
 *
 * Topology mirrors scenario 26 (closest twin): an in-proc warren+burrow
 * pair booted per-scenario so the `WARREN_FORGE=fake` selection stays
 * scoped here. The clone lands locally through the harness's standard
 * insteadOf rewrite — the same plumbing every scenario uses to keep git
 * traffic on tmp dirs; it is harness plumbing, not warren config.
 *
 * The assertions:
 *
 *   1. POST /projects on a `fake://` URL clones and registers.
 *   2. POST /runs dispatches; the run transitions queued → running →
 *      succeeded (natural finalize — the claude-code stub emits the
 *      runtime-terminal envelope, same as scenario 26).
 *   3. Reap pushes the run branch (the ref exists in the fixture repo)
 *      and opens a PR through FakeForge: run.prUrl is the fake's
 *      `fake://<key>/pulls/<n>` webUrl and the `reap.pr_opened` event
 *      carries the same ref.
 *   4. FakeForge RECORDED the openPullRequest call: the state file
 *      (WARREN_FAKE_FORGE_STATE_FILE — the cross-process observation
 *      seam, warren-2600) holds the PR record with the run's head/base
 *      branches.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly prUrl: string | null;
}

interface EventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

/** Mirrors `FakeForgeStateFile` (src/forge/fake/store.ts) — read-only view. */
interface FakeStateView {
	readonly prs: Record<
		string,
		readonly {
			readonly number: number;
			readonly headBranch: string;
			readonly baseBranch: string;
			readonly lifecycle: string;
		}[]
	>;
}

const FAKE_PROJECT_URL = "fake://warren-acceptance/sample-fake-forge";
const FAKE_REPO_KEY = "warren-acceptance/sample-fake-forge";
const RUN_DEADLINE_MS = 60_000;

export const scenario: Scenario = {
	id: "40",
	title:
		"FakeForge roundtrip — WARREN_FORGE=fake completes dispatch → reap → push → PR with zero domain-code changes (falsification test 1)",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-40-"));
		const gitConfigPath = join(scenarioRoot, "git-config");
		const stateFile = join(scenarioRoot, "fake-forge-state.json");

		// Harness-standard insteadOf plumbing: the fake:// clone URL resolves
		// to the shared sample fixture on disk.
		const harnessConfig = existsSync(ctx.fixtures.gitConfigPath)
			? await readFile(ctx.fixtures.gitConfigPath, "utf8")
			: "";
		await writeFile(
			gitConfigPath,
			`${harnessConfig.trimEnd()}\n[url "${ctx.fixtures.sampleProjectPath}"]\n\tinsteadOf = ${FAKE_PROJECT_URL}\n`,
		);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					// The whole point: select FakeForge and NOTHING else special.
					WARREN_FORGE: "fake",
					// Cross-process OBSERVATION seam only — the scenario reads the
					// recorded openPullRequest call back out of the booted warren.
					WARREN_FAKE_FORGE_STATE_FILE: stateFile,
				},
			});
			ctx.logger.info(`scenario-40: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// === 1. Register the FakeForge-owned project ===
			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: FAKE_PROJECT_URL },
			});
			assertEqual(
				project.gitUrl,
				FAKE_PROJECT_URL,
				"project row keeps the fake:// clone URL verbatim",
			);

			// === 2. Dispatch → lifecycle transitions ===
			const created = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
				body: {
					agent: "claude-code",
					project: project.id,
					// `closeseed <id>` drives the claude-code stub to close the
					// fixture's known seed and COMMIT it (same mechanism
					// scenario 26 relies on), so reap sees commitsAhead > 0 and
					// runs branch_push + pr_open.
					// The fixture's one known seed is `ah-stub-1`
					// (KNOWN_SEED_ID in lib/fixtures.ts — not re-exported on ctx).
					prompt: "scenario-40 fake-forge roundtrip — closeseed ah-stub-1",
				},
			});
			const runId = created.run.id;
			assertEqual(created.run.state, "queued", "run starts queued");

			// Lifecycle transitions, observed: the claude-code stub finalizes
			// near-instantly, so `running` can lapse between polls — collect
			// every state the poll sees and assert the endpoints of the
			// transition chain (queued at POST, succeeded at terminal).
			const observedStates = new Set<string>(["queued"]);
			const terminal = await waitForRunTerminal(http, runId, RUN_DEADLINE_MS);
			observedStates.add(terminal.state);
			assertEqual(
				terminal.state,
				"succeeded",
				`run reaches terminal 'succeeded' (got '${terminal.state}'; observed [${[...observedStates].join(", ")}])`,
			);

			// === 3. Reap pushed the branch and opened the PR via FakeForge ===
			const expectedPrUrl = `${FAKE_PROJECT_URL}/pulls/1`;
			assertEqual(
				terminal.prUrl,
				expectedPrUrl,
				"run.prUrl is the FakeForge-minted PR ref (fake://<key>/pulls/1)",
			);
			const runBranch = `warren/${runId}`;
			const branchSha = execFileSync(
				"git",
				["-C", ctx.fixtures.sampleProjectPath, "rev-parse", `refs/heads/${runBranch}`],
				{ encoding: "utf8" },
			).trim();
			assertTrue(
				/^[0-9a-f]{40}$/.test(branchSha),
				`run branch ${runBranch} was pushed to the fixture repo (rev-parse → ${branchSha})`,
			);

			const events: EventRow[] = [];
			for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
				events.push(row as EventRow);
			}
			const prOpened = events.find((e) => e.kind === "reap.pr_opened");
			if (prOpened === undefined) {
				throw new AcceptanceError(
					`run ${runId}: event stream missing 'reap.pr_opened'; saw kinds=[${events.map((e) => e.kind).join(", ")}]`,
				);
			}
			assertEqual(
				prOpened.payload?.prUrl,
				expectedPrUrl,
				"reap.pr_opened payload carries the FakeForge PR ref",
			);
			assertEqual(prOpened.payload?.mode, "created", "FakeForge PR opened in 'created' mode");

			// === 4. FakeForge recorded the openPullRequest call ===
			if (!existsSync(stateFile)) {
				throw new AcceptanceError(
					"FakeForge state file missing — openPullRequest was never recorded",
				);
			}
			const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeStateView;
			const record = state.prs[FAKE_REPO_KEY]?.[0];
			if (record === undefined) {
				throw new AcceptanceError(
					`FakeForge state file has no PR record for ${FAKE_REPO_KEY}; keys=[${Object.keys(state.prs).join(", ")}]`,
				);
			}
			assertEqual(record.number, 1, "FakeForge assigned PR number 1");
			assertEqual(record.headBranch, runBranch, "FakeForge recorded the run's head branch");
			assertEqual(record.baseBranch, "main", "FakeForge recorded the project base branch");
			assertEqual(record.lifecycle, "open", "recorded PR lifecycle is 'open'");

			ctx.logger.info("scenario-40: FakeForge roundtrip verified");
		} finally {
			await handle?.stop();
		}
	},
};
