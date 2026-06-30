/**
 * High-level project management: add (clone + persist), list, delete
 * (rm-rf + db). These are the operations behind `POST /projects`,
 * `GET /projects`, and `DELETE /projects/:id` (SPEC §8.1) — the HTTP
 * server is a thin envelope around these calls.
 *
 * Atomicity contract:
 *   - addProject leaves the system in either "row + dir on disk" or
 *     "neither" — clone failure rolls back, db conflict short-circuits
 *     before anything touches disk, and a row is only inserted after
 *     `git clone` returns success.
 *   - deleteProject removes the row *first*, then best-effort rms the
 *     on-disk clone (warren-5f19). The row delete and the
 *     `runs.project_id` SET-NULL cascade run as a single SQLite
 *     statement, so any concurrent referent (in-flight runs, history)
 *     is updated atomically. If the disk rmrf fails after the row is
 *     gone, the operator gets a logged warning and a stranded
 *     directory under the projects root — better than the prior
 *     ordering, where a row could remain pointing at a deleted
 *     directory and wedge subsequent dispatches against the project.
 *
 * The `localPath` returned by the clone is re-validated against the
 * configured projects root before any rm: defense-in-depth so a
 * tampered db row can never escape the projects dir.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { formatError, ValidationError } from "../core/errors.ts";
import type { ProjectsRepo } from "../db/repos/projects.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { BridgeLogger } from "../runs/stream/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import {
	type CloneProjectResult,
	cloneProjectRepo,
	DEFAULT_GIT_TIMEOUT_MS,
	type SpawnFn,
} from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import {
	detectProjectFeatures,
	type RefreshProjectCloneResult,
	refreshProjectClone,
} from "./refresh.ts";
import { parseGitHubUrl } from "./url.ts";

export interface AddProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly gitUrl: string;
	readonly defaultBranch?: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly now?: () => Date;
	/** Inject the cloner; defaults to the live `cloneProjectRepo`. */
	readonly clone?: typeof cloneProjectRepo;
	/**
	 * Override the feature-directory probe (warren-4e20). Defaults to the
	 * filesystem-backed `detectProjectFeatures`; tests inject a stub so
	 * the on-disk clone can stay empty.
	 */
	readonly detectFeatures?: typeof detectProjectFeatures;
}

export async function addProject(input: AddProjectInput): Promise<ProjectRow> {
	const { repo, config, gitUrl } = input;
	const parsed = parseGitHubUrl(gitUrl);

	const existing = await repo.findByGitUrl(gitUrl);
	if (existing) {
		throw new ValidationError(`project already exists: ${existing.id}`, {
			recoveryHint: "DELETE /projects/:id first if you want to re-clone",
		});
	}

	const cloneFn = input.clone ?? cloneProjectRepo;
	const clone: CloneProjectResult = await cloneFn({
		config,
		gitUrl,
		owner: parsed.owner,
		name: parsed.name,
		defaultBranch: input.defaultBranch,
		spawn: input.spawn,
		timeoutMs: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
	});

	const detect = input.detectFeatures ?? detectProjectFeatures;
	const features = detect(clone.localPath);

	return repo.create({
		gitUrl,
		localPath: clone.localPath,
		defaultBranch: clone.defaultBranch,
		hasPlot: features.hasPlot,
		hasSeeds: features.hasSeeds,
		now: input.now?.(),
	});
}

export interface RefreshProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly id: string;
	/** Branch, tag, or SHA. Defaults to the project row's tracked default_branch. */
	readonly ref?: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly now?: () => Date;
	/** Inject the refresher; defaults to the live `refreshProjectClone`. */
	readonly refresh?: typeof refreshProjectClone;
	/**
	 * Optional warren-config cache. When present, invalidated BEFORE
	 * `refreshProjectClone` runs so any reader that started parsing
	 * against the pre-fetch tree cannot commit a stale envelope to the
	 * cache (pl-5d74 risk #4). Omit when the caller has no cache (CLI
	 * one-shots, tests that don't exercise the HTTP surface).
	 */
	readonly warrenConfigs?: WarrenConfigCache;
}

export interface RefreshProjectResult {
	readonly project: ProjectRow;
	readonly headSha: string;
	readonly ref: string;
}

export async function refreshProject(input: RefreshProjectInput): Promise<RefreshProjectResult> {
	const { repo, config, id } = input;
	const row = await repo.require(id);
	const ref = input.ref ?? row.defaultBranch;
	if (ref === "") {
		throw new ValidationError("ref must be a non-empty string");
	}

	// warren-8f4c: read `agent.skipGitHooks` from the pre-refresh
	// envelope BEFORE invalidating the cache. Reading before invalidation
	// gives us the config the operator set for this run; a concurrent edit
	// to `.warren/config.yaml` that flips the knob will take effect on the
	// next run. Best-effort: any cache / I-O error falls back to arming
	// hooks (the safe default).
	let armHooks = true;
	if (input.warrenConfigs !== undefined) {
		try {
			const envelope = await input.warrenConfigs.get(id, row.localPath);
			if (envelope.defaults?.agent?.skipGitHooks === true) armHooks = false;
		} catch {
			// Unreadable config → arm hooks by default.
		}
	}

	// Drop the cached envelope BEFORE the working tree changes. Per
	// pl-5d74 risk #4, this guarantees a concurrent
	// GET /projects/:id/warren-config either (a) joined the in-flight
	// pre-fetch load and observed the stale envelope without it being
	// committed, or (b) starts a fresh parse against the post-fetch tree.
	// No caller observes the post-refresh row paired with the pre-refresh
	// parse.
	input.warrenConfigs?.invalidate(id);

	const refreshFn = input.refresh ?? refreshProjectClone;
	const result: RefreshProjectCloneResult = await refreshFn({
		config,
		localPath: row.localPath,
		ref,
		spawn: input.spawn,
		timeoutMs: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		armHooks,
	});

	const updated = await repo.recordRefresh({
		id: row.id,
		headSha: result.headSha,
		hasPlot: result.features.hasPlot,
		hasSeeds: result.features.hasSeeds,
		now: input.now?.(),
	});
	return { project: updated, headSha: result.headSha, ref: result.ref };
}

export interface DeleteProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly id: string;
	/** Filesystem probes — overrideable for tests. */
	readonly exists?: (path: string) => boolean;
	readonly rmrf?: (path: string) => Promise<void>;
	/** Optional structured logger; warnings about stranded clones go here. */
	readonly logger?: BridgeLogger;
	/**
	 * Optional warren-config cache. Invalidated after the row delete so a
	 * future re-registration under the same id (or a stale reader) never
	 * sees the deleted project's parsed envelope.
	 */
	readonly warrenConfigs?: WarrenConfigCache;
}

export async function deleteProject(input: DeleteProjectInput): Promise<ProjectRow> {
	const { repo, config, id } = input;
	const exists = input.exists ?? existsSync;
	const rmrf = input.rmrf ?? defaultRmrf;

	const row = await repo.require(id);
	assertPathUnderRoot(row.localPath, config.root);

	// Row first. The FK on `runs.project_id` is `ON DELETE SET NULL`, so
	// SQLite atomically orphans every referencing run inside the same
	// implicit transaction. Doing this before the disk rm guarantees we
	// never leave a `projects` row pointing at a missing directory —
	// that combination wedged subsequent dispatches against the project
	// (warren-5f19).
	await repo.delete(id);
	input.warrenConfigs?.invalidate(id);

	if (exists(row.localPath)) {
		try {
			await rmrf(row.localPath);
		} catch (err) {
			input.logger?.warn?.(
				{ projectId: id, localPath: row.localPath, err: formatError(err) },
				"deleteProject: row removed but disk rmrf failed; stranded clone left for manual cleanup",
			);
		}
	}

	return row;
}

export async function listProjects(repo: ProjectsRepo): Promise<ProjectRow[]> {
	return repo.listAll();
}

function assertPathUnderRoot(localPath: string, root: string): void {
	const rootResolved = resolve(root);
	const pathResolved = resolve(localPath);
	if (pathResolved !== rootResolved && !pathResolved.startsWith(rootResolved + sep)) {
		// A project row whose localPath isn't under the configured root is a
		// data-integrity bug, not a user-facing condition. Better to error
		// loudly than to rm-rf an arbitrary path.
		throw new ProjectUnavailableError(
			`project localPath ${localPath} is not under projects root ${root}`,
			{ recoveryHint: "manually remove the project's files and the row from the db" },
		);
	}
}

const defaultRmrf = async (path: string): Promise<void> => {
	await rm(path, { recursive: true, force: true });
};
