/**
 * CI-fixer poll for the R-06 scheduler tick (warren-0b75).
 *
 * Extracted from `tick.ts` to keep that module under the file-size budget.
 * `runCiFixerPass` ties the pure `pollProjectCiFixer` helper (warren-05ea)
 * into one per-project pass: it enumerates the project's open-PR candidates,
 * feeds each verdict + attempt history through the poller's guard rails, and
 * stamps a durable `ci_fixer.dispatched` system event on the PR's opener run
 * for every fixer it dispatches. No-op unless the deployment wired the
 * poller seam AND the project opted in via `ciFixer.enabled`.
 */

import {
	CI_FIXER_DISPATCHED_EVENT,
	type CiFixerPollResult,
	type CiFixerSpawnFn,
	type CiFixerSpawnInput,
	pollProjectCiFixer,
} from "../ci-fixer/poller.ts";
import type { Repos } from "../db/repos/index.ts";
import type { ProjectRow } from "../db/schema.ts";
import { resolveRunBranchPrefix } from "../runs/branch.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import type { TickLogger } from "./tick.ts";

/**
 * Spawn seam the tick hands the CI-fixer poller. The poller only carries
 * per-PR context (`prompt`, `parentRunId`, `targetBranch`, `prUrl`); the
 * tick widens it with the per-project `projectId` + resolved fixer
 * `agentName` (`ciFixer.role`) so the boot-level `spawnRun` wiring has
 * everything it needs.
 */
export interface TickCiFixerSpawnInput extends CiFixerSpawnInput {
	readonly projectId: string;
	readonly agentName: string;
}

export type TickCiFixerSpawnFn = (input: TickCiFixerSpawnInput) => Promise<{ runId: string }>;

/**
 * Deployment-level CI-fixer wiring. Absent in tests / deployments that
 * don't wire the poller — `runCiFixerPass` then skips entirely, so a
 * project's `ciFixer.enabled` is a no-op without it.
 */
export interface TickCiFixerDeps {
	/** `GITHUB_TOKEN`; an empty value surfaces per-PR `error` results. */
	readonly githubToken: string;
	readonly spawn: TickCiFixerSpawnFn;
	/** `WARREN_RUN_BRANCH_PREFIX` fallback used to reconstruct PR head refs. */
	readonly runBranchPrefixDefault?: string;
	/** Test seam for the GitHub check-runs fetch. */
	readonly fetch?: typeof fetch;
}

export interface RunCiFixerPassInput {
	readonly repos: Pick<Repos, "runs" | "events">;
	readonly ciFixer: TickCiFixerDeps;
	readonly project: ProjectRow;
	readonly config: LoadedWarrenConfig;
	readonly now: Date;
	readonly logger?: TickLogger;
}

export async function runCiFixerPass(input: RunCiFixerPassInput): Promise<void> {
	const { repos, ciFixer, project, config, now, logger } = input;
	const settings = config.defaults?.ciFixer;
	if (settings === undefined || !settings.enabled) return;

	const candidates = await repos.runs.listPrCandidatesByProject(project.id);
	if (candidates.length === 0) return;

	const branchPrefix = resolveRunBranchPrefix({
		...(config.defaults?.runBranchPrefix !== undefined
			? { projectDefault: config.defaults.runBranchPrefix }
			: {}),
		...(ciFixer.runBranchPrefixDefault !== undefined
			? { envDefault: ciFixer.runBranchPrefixDefault }
			: {}),
	});

	// Widen the poller's per-PR spawn input with the per-project projectId +
	// resolved fixer role so the boot-level spawnRun wiring is fully fed.
	const spawn: CiFixerSpawnFn = (spawnInput) =>
		ciFixer.spawn({ ...spawnInput, projectId: project.id, agentName: settings.role });

	const results = await pollProjectCiFixer({
		candidates,
		settings: {
			enabled: settings.enabled,
			maxRetries: settings.maxRetries,
			cooldownMinutes: settings.cooldownMinutes,
		},
		branchPrefix,
		token: ciFixer.githubToken,
		...(ciFixer.fetch !== undefined ? { fetch: ciFixer.fetch } : {}),
		history: (prUrl) => repos.runs.fixAttemptHistoryByPrUrl(prUrl),
		spawn,
		now,
		logTailLines: settings.logTailLines,
	});

	for (const result of results) {
		await handleCiFixerResult(repos, logger, project.id, now, result);
	}
}

async function handleCiFixerResult(
	repos: Pick<Repos, "events">,
	logger: TickLogger | undefined,
	projectId: string,
	now: Date,
	result: CiFixerPollResult,
): Promise<void> {
	if (result.kind === "dispatched") {
		logger?.info(
			{ projectId, prUrl: result.prUrl, runId: result.runId, parentRunId: result.parentRunId },
			"scheduler.ci_fixer_dispatched",
		);
		await appendDispatchedEvent(repos, logger, now, result);
		return;
	}
	if (result.kind === "skipped") {
		logger?.info(
			{ projectId, prUrl: result.prUrl, reason: result.reason },
			"scheduler.ci_fixer_skipped",
		);
		return;
	}
	logger?.warn(
		{ projectId, prUrl: result.prUrl, reason: result.reason },
		"scheduler.ci_fixer_failed",
	);
}

/**
 * Stamp a `ci_fixer.dispatched` system event on the PR's opener run so the
 * operator can trace the fixer chain without tailing logs. Fire-and-log —
 * a failed event write must not derail the rest of the tick.
 */
async function appendDispatchedEvent(
	repos: Pick<Repos, "events">,
	logger: TickLogger | undefined,
	now: Date,
	result: { prUrl: string; runId: string; parentRunId: string },
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(result.parentRunId)) ?? 0) + 1;
		await repos.events.append({
			runId: result.parentRunId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: CI_FIXER_DISPATCHED_EVENT,
			stream: "system",
			payload: { prUrl: result.prUrl, fixerRunId: result.runId },
		});
	} catch (err) {
		logger?.error(
			{ runId: result.parentRunId, reason: err instanceof Error ? err.message : String(err) },
			"scheduler.ci_fixer_event_failed",
		);
	}
}
