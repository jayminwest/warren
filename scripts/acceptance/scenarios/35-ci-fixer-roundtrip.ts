/**
 * Scenario 35 — CI-fixer round-trip (warren-a993).
 *
 * Exercises the full polling CI-fixer flow against a *real* GitHub repo and
 * GitHub Actions, end-to-end through a live in-proc warren+burrow:
 *
 *   1. warren spawns an opener run that commits + pushes a `${prefix}/<runId>`
 *      branch and auto-opens a PR (reap pr-open, warren-f6af). The push is
 *      authenticated by the supervisor's `insteadOf` GITHUB_TOKEN rewrite
 *      (warren-dcf3) — see the operator setup notes below.
 *   2. GitHub Actions runs the opener PR's CI and concludes `failure`.
 *   3. The scheduler tick's CI-fixer poller (warren-0b75) fetches the PR's
 *      check-runs, classifies `failing`, and dispatches a `ci-fixer` run
 *      back-linked to the opener via `parentRunId`. The fixer's burrow branch
 *      is pinned to the PR head ref (`targetBranch`, warren-a993) and its
 *      prompt carries the failing-check context + CI log tail.
 *
 * The warren-side assertions (a `trigger: "ci-fixer"` run appears, linked to
 * the opener, sharing its `prUrl`, with a CI-failure prompt) certify the
 * spawn/reap `targetBranch` integration and CI-log extraction landed by
 * warren-a993 on top of the warren-05ea / warren-0b75 scaffolding.
 *
 * ## Operator setup (why this is env-gated)
 *
 * Unlike the local-git fixtures the rest of the harness uses (fake GitHub
 * URLs rewritten to on-disk repos), the CI-fixer poller calls the real
 * `api.github.com` check-runs endpoint and only acts on real GitHub Actions
 * verdicts. There is no faithful local substitute, so this scenario is
 * skip-gated (same convention as scenario 19 / warren-on-postgres) on:
 *
 *   - `GITHUB_TOKEN` — a token with `repo` scope, owned by the BOOTED
 *     warren (forge-contract.md §6.14): `bootInProc` passes it through
 *     (warren-2740) and warren spends it on the check-runs fetch
 *     (scheduler `githubToken`), the branch push, and auto-open-PR.
 *     The harness borrows the same token only for best-effort PR/branch
 *     cleanup in the `finally` below (see `lib/github.ts`).
 *   - `WARREN_ACCEPT_CI_FIXER_REPO` — an `https://github.com/<owner>/<repo>.git`
 *     URL to a repo the operator controls, prepared as a clone of the
 *     harness sample project (so the `stub-shell` agent in `burrow.toml`
 *     resolves) PLUS:
 *       * `.warren/config.yaml` with `ciFixer: { enabled: true }`, and
 *       * a CI workflow (`.github/workflows/*.yml`) that runs on
 *         `pull_request` and exits non-zero (so the opener PR's CI fails
 *         deterministically on any pushed branch).
 *
 * When either env var is unset the scenario records `skipped`, keeping the
 * default `bun run scripts/acceptance/run.ts` green on a stock machine while
 * a CI matrix job that wires the secrets lights it up.
 *
 * In-proc only: the flow drives the host-side scheduler tick and a real
 * git push, neither of which the container harness bind-mounts.
 */

import { randomBytes } from "node:crypto";
import { isTerminalRunState } from "../../../src/core/wire.ts";
import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	skipScenario,
} from "../lib/assert.ts";
import { closePullRequestAndBranch, parseRepoSlug } from "../lib/github.ts";
import { WarrenHttp } from "../lib/http.ts";
import { pollAcceptance } from "../lib/poll.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger: string;
	readonly prompt: string;
	readonly prUrl: string | null;
	readonly parentRunId: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

interface ListRunsResponse {
	readonly runs: readonly RunRow[];
}

const POLL_INTERVAL_MS = 2_000;
// Clone + stub run + reap + push + PR-open.
const OPENER_BUDGET_MS = 180_000;
// GitHub Actions runner latency + a few scheduler ticks. Generous: this
// scenario is opt-in and a slow runner queue must not flake it.
const FIXER_DISPATCH_BUDGET_MS = 600_000;

export const scenario: Scenario = {
	id: "35",
	title: "CI-fixer round-trip: failing PR → poller dispatches a ci-fixer run on the PR branch",
	modes: ["in-proc"],
	async run(ctx) {
		const token = process.env.GITHUB_TOKEN ?? "";
		const repoUrl = process.env.WARREN_ACCEPT_CI_FIXER_REPO ?? "";
		if (token === "" || repoUrl === "") {
			skipScenario(
				"GITHUB_TOKEN + WARREN_ACCEPT_CI_FIXER_REPO required for the live CI-fixer flow",
			);
		}
		const slug = parseRepoSlug(repoUrl);

		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
		// The stub agent was seeded at boot via WARREN_SEED_AGENTS_FILE
		// (warren-e376); POST /agents/refresh is deleted (pl-3a79). GET it
		// to prove boot seeding landed before spawning against it.
		await http.expectStatus(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: repoUrl },
		});

		// Unique seed id per run so the stub agent's closeseed commit is
		// distinct each invocation (idempotency across re-runs).
		const seedId = `ci-fixer-accept-${randomBytes(3).toString("hex")}`;
		let opener: RunRow | null = null;
		try {
			const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
				body: {
					agent: ctx.fixtures.stubAgentName,
					project: project.id,
					prompt: `closeseed ${seedId}`,
				},
			});
			opener = await waitForOpenerPr(http, created.run.id);
			assertTrue(
				opener.prUrl !== null && /\/pull\/\d+/.test(opener.prUrl),
				`opener run did not auto-open a PR (prUrl=${JSON.stringify(opener.prUrl)})`,
			);

			const fixer = await waitForCiFixerRun(http, project.id, opener.id);
			assertEqual(fixer.trigger, "ci-fixer", "dispatched fixer run.trigger");
			assertEqual(fixer.parentRunId, opener.id, "fixer.parentRunId back-links to the opener");
			assertEqual(fixer.prUrl, opener.prUrl, "fixer inherits the opener's PR url");
			assertTrue(
				fixer.prompt.includes("CI is failing on the pull request"),
				"fixer prompt carries the CI-failure context",
			);
		} finally {
			// Best-effort cleanup so the operator's repo doesn't accumulate
			// branches/PRs across runs. Each step is independently guarded.
			await cancelRun(http, opener?.id);
			await cancelLatestFixer(http, project.id);
			await closePullRequestAndBranch(token, slug, opener?.prUrl ?? null);
			await deleteProject(http, project.id);
		}
	},
};

async function waitForOpenerPr(http: WarrenHttp, runId: string): Promise<RunRow> {
	return pollAcceptance({
		label: "opener run PR",
		id: runId,
		timeoutMs: OPENER_BUDGET_MS,
		intervalMs: POLL_INTERVAL_MS,
		fetchRow: async (): Promise<RunRow> => {
			const row = await http.sdkClient().getRun(runId);
			if (isTerminalRunState(row.state) && (row.prUrl === null || row.prUrl === "")) {
				// Terminal with no PR: one immediate recheck in case reap is
				// mid-write, then fail clearly.
				const recheck = await http.sdkClient().getRun(runId);
				if (recheck.prUrl !== null && recheck.prUrl !== "") return recheck;
				throw new AcceptanceError(
					`opener run ${runId} reached '${row.state}' without opening a PR — check GITHUB_TOKEN push auth + the repo's auto-open-PR config`,
				);
			}
			return row;
		},
		isDone: (row) => row.prUrl !== null && row.prUrl !== "",
		describe: (row) => `state=${row.state} prUrl=${JSON.stringify(row.prUrl)}`,
	});
}

async function waitForCiFixerRun(
	http: WarrenHttp,
	projectId: string,
	openerId: string,
): Promise<RunRow> {
	return pollAcceptance({
		label: "ci-fixer run",
		id: openerId,
		timeoutMs: FIXER_DISPATCH_BUDGET_MS,
		intervalMs: POLL_INTERVAL_MS,
		fetchRow: async (): Promise<RunRow | null> => {
			const res = await http.expectJson<ListRunsResponse>(
				"GET",
				`/runs?project=${encodeURIComponent(projectId)}`,
				200,
			);
			return res.runs.find((r) => r.trigger === "ci-fixer" && r.parentRunId === openerId) ?? null;
		},
		isDone: (run): run is RunRow => run !== null,
		describe: (run) => (run === null ? "not dispatched yet" : run.id),
	});
}

async function cancelRun(http: WarrenHttp, runId: string | undefined): Promise<void> {
	if (runId === undefined) return;
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch {
		// Run may already be terminal — cancel is idempotent.
	}
}

async function cancelLatestFixer(http: WarrenHttp, projectId: string): Promise<void> {
	try {
		const res = await http.expectJson<ListRunsResponse>(
			"GET",
			`/runs?project=${encodeURIComponent(projectId)}`,
			200,
		);
		const fixer = res.runs.find((r) => r.trigger === "ci-fixer");
		await cancelRun(http, fixer?.id);
	} catch {
		// Best-effort.
	}
}

async function deleteProject(http: WarrenHttp, projectId: string): Promise<void> {
	try {
		await http.request("DELETE", `/projects/${encodeURIComponent(projectId)}`, { body: {} });
	} catch {
		// Best-effort.
	}
}
