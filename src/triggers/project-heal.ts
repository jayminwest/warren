/**
 * Scheduler self-heal + notice rate-limiting (warren-1ec7).
 *
 * On an ephemeral-volume deployment (K8s, fresh PVC) the `projects` table
 * migrates but the host clones under `/data/projects` do not, so every
 * scheduler tick hit `loadWarrenConfig` → `project clone missing on disk`
 * and re-logged `scheduler.project_failed` at error level for a dozen
 * projects, every tick. This module closes that gap two ways:
 *
 *   1. Self-heal — when a registered project's clone is missing on disk,
 *      re-clone it from the row's `gitUrl` (matching the ephemeral-volume
 *      reality) instead of failing the tick. `recloneMissingProject`
 *      reuses `cloneProjectRepo`, so the same token/`insteadOf` auth path
 *      the dispatch clone uses (warren-57ad) applies here too.
 *
 *   2. Rate-limit — a `ProjectHealTracker` gates repeated per-project
 *      notices (missing-clone re-clone failures, `sd_list_failed`,
 *      generic `project_failed`) to once per interval (default 1h) and
 *      backs off re-clone attempts exponentially so a dozen dead repos
 *      (deleted upstream / broken auth) neither flood the logs nor
 *      re-clone every tick.
 *
 * The healer is injected into the tick via `TickDeps.ensureProjectClone`
 * and the tracker via `TickDeps.noticeGate`; when both are absent the tick
 * behaves exactly as before (unit tests that don't wire them are
 * untouched). `bootScheduler` constructs one tracker for the scheduler's
 * process lifetime — a restart resets the backoff counters, same as
 * `CronRetryTracker`.
 */

import { existsSync } from "node:fs";
import { formatError } from "../core/errors.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { Forge } from "../forge/contract.ts";
import { cloneProjectRepo, type SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { parseProjectUrl } from "../projects/url.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";

/** Default gap between repeated notices for the same unresolved condition. */
export const NOTICE_INTERVAL_MS = 3_600_000;
/** First re-clone retry delay after a failure; doubles per consecutive failure. */
export const RECLONE_BACKOFF_BASE_MS = 300_000;
/** Ceiling on the exponential re-clone backoff. */
export const RECLONE_BACKOFF_MAX_MS = 3_600_000;

interface RecloneBackoff {
	readonly count: number;
	readonly nextAttemptAt: number;
}

/**
 * Per-project memory shared across ticks: notice de-dup timestamps plus
 * re-clone backoff state. Constructed once by `bootScheduler`.
 */
export class ProjectHealTracker {
	private readonly notices = new Map<string, number>();
	private readonly reclone = new Map<string, RecloneBackoff>();

	constructor(private readonly noticeIntervalMs: number = NOTICE_INTERVAL_MS) {}

	/**
	 * True when a notice keyed by `key` should be logged now — the first
	 * time it is seen, then again only once `noticeIntervalMs` has elapsed.
	 * Records the log time as a side effect.
	 */
	shouldNotify(key: string, nowMs: number): boolean {
		const last = this.notices.get(key);
		if (last !== undefined && nowMs - last < this.noticeIntervalMs) return false;
		this.notices.set(key, nowMs);
		return true;
	}

	/** Forget a condition so its next occurrence logs immediately. */
	clearNotice(key: string): void {
		this.notices.delete(key);
	}

	/** True when no backoff is pending, or the backoff window has elapsed. */
	canAttemptReclone(projectId: string, nowMs: number): boolean {
		const backoff = this.reclone.get(projectId);
		return backoff === undefined || nowMs >= backoff.nextAttemptAt;
	}

	/**
	 * Record a failed re-clone and arm the next backoff window
	 * (exponential: base × 2^(n-1), capped). Returns the consecutive
	 * failure count for logging.
	 */
	recordRecloneFailure(projectId: string, nowMs: number): number {
		const count = (this.reclone.get(projectId)?.count ?? 0) + 1;
		const delay = Math.min(RECLONE_BACKOFF_BASE_MS * 2 ** (count - 1), RECLONE_BACKOFF_MAX_MS);
		this.reclone.set(projectId, { count, nextAttemptAt: nowMs + delay });
		return count;
	}

	/** Clear backoff state once the clone is present again. */
	clearRecloneFailure(projectId: string): void {
		this.reclone.delete(projectId);
	}
}

export interface RecloneMissingProjectInput {
	readonly project: ProjectRow;
	readonly config: ProjectsConfig;
	readonly spawn: SpawnFn;
	/** `GITHUB_TOKEN` for private-repo access — see `CloneProjectInput.token`. */
	readonly gitCredential?: GitSpawnCredential;
	readonly timeoutMs?: number;
	/** Injected cloner; defaults to the live `cloneProjectRepo`. */
	readonly clone?: typeof cloneProjectRepo;
	/**
	 * The boot-resolved forge, so a project registered under a non-GitHub
	 * grammar lays out under the same `owner`/`name` `addProject` chose.
	 */
	readonly forge?: Forge;
}

/**
 * Re-clone a registered project whose on-disk clone vanished. Derives
 * `owner`/`name` from the row's `gitUrl` (the same parse `addProject`
 * used), pins the stored `defaultBranch` so no extra remote round-trip is
 * needed to detect it, and forwards the token so private repos re-clone on
 * a bare `warren serve` (K8s) exactly like the dispatch path. Throws on
 * clone failure — the caller decides whether to back off.
 */
export async function recloneMissingProject(input: RecloneMissingProjectInput): Promise<void> {
	const parsed = parseProjectUrl(input.project.gitUrl, input.forge);
	const cloneFn = input.clone ?? cloneProjectRepo;
	await cloneFn({
		config: input.config,
		gitUrl: input.project.gitUrl,
		owner: parsed.owner,
		name: parsed.name,
		defaultBranch: input.project.defaultBranch,
		gitCredential: input.gitCredential,
		spawn: input.spawn,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	});
}

/** Minimal logger surface the healer needs; `TickLogger` satisfies it. */
export interface HealLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Outcome of a self-heal probe:
 *   - `present`  — the clone is on disk; proceed with the tick.
 *   - `recloned` — the clone was missing and re-cloned; proceed.
 *   - `skip`     — the clone is missing and either backing off or its
 *                  re-clone failed; the caller should skip this project
 *                  for the tick (any log already emitted, gated).
 */
export type ProjectCloneHealResult = "present" | "recloned" | "skip";

export type EnsureProjectCloneFn = (project: ProjectRow) => Promise<ProjectCloneHealResult>;

export interface ProjectCloneHealerInput {
	readonly tracker: ProjectHealTracker;
	readonly config: ProjectsConfig;
	readonly spawn: SpawnFn;
	/**
	 * Per-reclone credential mint (warren-0b49, forge-contract.md §4 —
	 * credentials are minted, never held). Invoked immediately before the
	 * re-clone spawns git; the boot wiring resolves it from the boot-resolved
	 * forge via `mintGitCredential`. Absent → anonymous git.
	 */
	readonly mintCredential?: (project: ProjectRow) => Promise<GitSpawnCredential | undefined>;
	readonly timeoutMs?: number;
	readonly logger?: HealLogger;
	/** Filesystem probe — overrideable for tests. */
	readonly exists?: (path: string) => boolean;
	/** Injected re-cloner; defaults to `recloneMissingProject`. */
	readonly reclone?: typeof recloneMissingProject;
	readonly now?: () => Date;
	/**
	 * The boot-resolved forge, forwarded to `recloneMissingProject` so a
	 * project registered under a non-GitHub grammar heals under the same
	 * on-disk layout `addProject` chose.
	 */
	readonly forge?: Forge;
}

/**
 * Build the `ensureProjectClone` seam wired into `TickDeps`. The returned
 * function is stateless per call — all cross-tick memory lives in the
 * injected `tracker` — so it can be reused across every project and tick.
 */
export function createProjectCloneHealer(input: ProjectCloneHealerInput): EnsureProjectCloneFn {
	const exists = input.exists ?? existsSync;
	const recloneFn = input.reclone ?? recloneMissingProject;

	return async (project: ProjectRow): Promise<ProjectCloneHealResult> => {
		const nowMs = (input.now?.() ?? new Date()).getTime();
		const noticeKey = `reclone:${project.id}`;

		if (exists(project.localPath)) {
			input.tracker.clearRecloneFailure(project.id);
			input.tracker.clearNotice(noticeKey);
			return "present";
		}

		// Missing clone: honor the backoff window so a dozen dead repos
		// don't all re-clone every tick.
		if (!input.tracker.canAttemptReclone(project.id, nowMs)) return "skip";

		try {
			await attemptReclone(input, recloneFn, project);
			input.tracker.clearRecloneFailure(project.id);
			input.tracker.clearNotice(noticeKey);
			input.logger?.info(
				{ projectId: project.id, localPath: project.localPath },
				"scheduler.project_recloned",
			);
			return "recloned";
		} catch (err) {
			const attempts = input.tracker.recordRecloneFailure(project.id, nowMs);
			if (input.tracker.shouldNotify(noticeKey, nowMs)) {
				input.logger?.error(
					{
						projectId: project.id,
						localPath: project.localPath,
						attempts,
						reason: formatError(err),
					},
					"scheduler.project_reclone_failed",
				);
			}
			return "skip";
		}
	};
}

/**
 * One re-clone attempt. §4 (warren-0b49): the credential is minted
 * immediately before the git spawn — a short-lived (App) credential could
 * not survive a value captured at boot.
 */
async function attemptReclone(
	input: ProjectCloneHealerInput,
	recloneFn: typeof recloneMissingProject,
	project: ProjectRow,
): Promise<void> {
	const credential =
		input.mintCredential !== undefined ? await input.mintCredential(project) : undefined;
	await recloneFn({
		project,
		config: input.config,
		spawn: input.spawn,
		...(input.forge !== undefined ? { forge: input.forge } : {}),
		...(credential !== undefined ? { gitCredential: credential } : {}),
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	});
}
