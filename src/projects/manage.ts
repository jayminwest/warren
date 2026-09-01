/**
 * High-level project management: add (clone + persist), get, list, delete
 * (rm-rf + db). These are the operations behind `POST /projects`,
 * `GET /projects`, `GET /projects/:id`, and `DELETE /projects/:id`
 * (docs/http-api.md) — the HTTP server is a thin envelope around these
 * calls.
 *
 * Atomicity contract:
 *   - addProject leaves the system in either "row + dir on disk" or
 *     "neither" — clone failure rolls back, db conflict short-circuits
 *     before anything touches disk, and a row is only inserted after
 *     `git clone` returns success.
 *   - deleteProject removes the row *first*, then best-effort rms the
 *     on-disk clone (warren-5f19). The row delete and the
 *     `runs.project_id` ON DELETE CASCADE (warren-41b3) run as a single
 *     SQLite statement, so the project's runs — and, via
 *     `events.run_id` ON DELETE CASCADE, their event transcripts — are
 *     removed atomically with the row rather than orphaned with
 *     `project_id = NULL`. Doing this before the disk rm guarantees we
 *     never leave a `projects` row pointing at a missing directory. If
 *     the disk rmrf fails after the row is gone, the operator gets a
 *     logged warning and a stranded directory under the projects root —
 *     better than the prior ordering, where a row could remain pointing
 *     at a deleted directory and wedge subsequent dispatches against the
 *     project.
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
import type { Forge } from "../forge/contract.ts";
import type { BridgeLogger } from "../runs/stream/index.ts";
import { assertSandboxGit, type SandboxGitPreflightResult } from "../sandbox/git-preflight.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import {
	type CloneProjectResult,
	cloneProjectRepo,
	DEFAULT_GIT_TIMEOUT_MS,
	type SpawnFn,
} from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { assertGitUrlAllowlisted, type PublicAllowlist } from "./public-allowlist.ts";
import {
	detectProjectFeatures,
	type RefreshProjectCloneResult,
	refreshProjectClone,
} from "./refresh.ts";
import { assertNoUserinfo, parseProjectUrl } from "./url.ts";

export interface AddProjectInput {
	readonly repo: ProjectsRepo;
	readonly config: ProjectsConfig;
	readonly gitUrl: string;
	readonly defaultBranch?: string;
	/**
	 * GitHub token for private-repo clones (`GITHUB_TOKEN`), forwarded to
	 * `cloneProjectRepo` — see `CloneProjectInput.token`. Absent/empty →
	 * anonymous clone.
	 */
	readonly gitCredential?: GitSpawnCredential;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly now?: () => Date;
	/**
	 * Public-instance allowlist (warren-ce9b), enforced HERE so every
	 * registration surface — `POST /projects` and the
	 * `warren add-project` CLI — holds the same line (warren-0883).
	 * `undefined` (token mode) ⇒ no restriction.
	 */
	readonly publicAllowlist?: PublicAllowlist;
	/** Inject the cloner; defaults to the live `cloneProjectRepo`. */
	readonly clone?: typeof cloneProjectRepo;
	/**
	 * Override the feature-directory probe (warren-4e20). Defaults to the
	 * filesystem-backed `detectProjectFeatures`; tests inject a stub so
	 * the on-disk clone can stay empty.
	 */
	readonly detectFeatures?: typeof detectProjectFeatures;
	/**
	 * Boot-resolved forge (warren-2600): decides which clone URLs warren can
	 * host. A URL `parseGitHubUrl` rejects but the forge OWNS
	 * (`parseRepoRef` non-null, e.g. FakeForge's `fake://<owner>/<name>`)
	 * still registers, deriving its on-disk path segments via
	 * `parseForgeOwnedUrl`. Omit ⇒ the legacy github.com-only posture.
	 */
	readonly forge?: Forge;
	/**
	 * Sandbox git preflight (warren-1219): when provided (LocalProvider
	 * topology only), the resolved git binary is proven to EXECUTE inside
	 * the composed sandbox profile BEFORE anything is cloned — a broken
	 * git (e.g. macOS nix git with dylibs outside the seatbelt-readable
	 * paths) fails registration with a typed error naming the binary,
	 * instead of surfacing post-hoc as a dropped_commit run failure.
	 * Boot-cached by the caller (`sandboxGitPreflightCached`).
	 */
	readonly sandboxGitPreflight?: () => Promise<SandboxGitPreflightResult>;
}

export async function addProject(input: AddProjectInput): Promise<ProjectRow> {
	const { repo, config, gitUrl } = input;
	// warren-ce9b/0883: on a public instance only allowlisted repos may
	// ever be registered — refused here, BEFORE anything is cloned, from
	// the single enforcement site every surface shares.
	assertGitUrlAllowlisted(input.publicAllowlist, gitUrl);
	assertNoUserinfo(gitUrl);
	const parsed = parseProjectUrl(gitUrl, input.forge);

	const existing = await repo.findByGitUrl(gitUrl);
	if (existing) {
		throw new ValidationError(`project already exists: ${existing.id}`, {
			recoveryHint: "DELETE /projects/:id first if you want to re-clone",
		});
	}

	// warren-1219: prove the sandbox git executes BEFORE cloning, so a
	// host with a broken sandbox toolchain leaves "neither" (no row, no
	// disk clone) — the same atomicity contract as a clone failure.
	if (input.sandboxGitPreflight !== undefined) {
		assertSandboxGit(await input.sandboxGitPreflight());
	}

	const cloneFn = input.clone ?? cloneProjectRepo;
	const clone: CloneProjectResult = await cloneFn({
		config,
		gitUrl,
		owner: parsed.owner,
		name: parsed.name,
		defaultBranch: input.defaultBranch,
		gitCredential: input.gitCredential,
		spawn: input.spawn,
		timeoutMs: input.timeoutMs ?? config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
	});

	const detect = input.detectFeatures ?? detectProjectFeatures;
	const features = detect(clone.localPath);

	return repo.create({
		gitUrl,
		localPath: clone.localPath,
		defaultBranch: clone.defaultBranch,
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
	/**
	 * Detached-HEAD-safe fetch-only mode (warren-232d): fetch this 40-hex
	 * commit from origin without moving the host clone's HEAD. Forwarded to
	 * `refreshProjectClone` — see `RefreshProjectCloneInput.fetchCommit`.
	 * Takes precedence over `ref` for the clone operation; the echo `ref` in
	 * the result is the fetched SHA.
	 */
	readonly fetchCommit?: string;
	/**
	 * GitHub token for private-repo fetches (`GITHUB_TOKEN`), forwarded to
	 * `refreshProjectClone` — see `RefreshProjectCloneInput.token`.
	 */
	readonly gitCredential?: GitSpawnCredential;
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
		...(input.fetchCommit !== undefined ? { fetchCommit: input.fetchCommit } : {}),
		gitCredential: input.gitCredential,
		spawn: input.spawn,
		timeoutMs: input.timeoutMs ?? config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		armHooks,
	});

	// Drop the cached envelope AGAIN after the fetch/reset lands
	// (warren-e376). The invalidate-before covers readers that were
	// already in flight when the refresh started, but a reader that
	// STARTS mid-refresh (e.g. the 1s trigger-scheduler tick in the
	// acceptance harness) parses the working tree mid-swap — possibly
	// the pre-fetch tree or a partially checked-out one — and commits
	// that stale envelope as the post-refresh cache entry. Scenario 15's
	// Run Now 404'd on exactly this. Invalidating after the reset forces
	// the next get() to parse the settled tree.
	input.warrenConfigs?.invalidate(id);

	const updated = await repo.recordRefresh({
		id: row.id,
		headSha: result.headSha,
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

	// Row first. The FK on `runs.project_id` is `ON DELETE CASCADE`
	// (warren-41b3), so SQLite atomically deletes every referencing run —
	// and, via `events.run_id` ON DELETE CASCADE, their event transcripts —
	// inside the same implicit transaction. Doing this before the disk rm
	// guarantees we never leave a `projects` row pointing at a missing
	// directory — that combination wedged subsequent dispatches against
	// the project (warren-5f19).
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

/**
 * Single-project read behind `GET /projects/:id` (warren-2a89). `require`
 * throws NotFoundError for an unknown id, which the handler layer renders
 * as the canonical 404 envelope.
 */
export async function getProject(repo: ProjectsRepo, id: string): Promise<ProjectRow> {
	return repo.require(id);
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
