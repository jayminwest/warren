/**
 * The in-process LocalProvider engine (warren-413d, plan pl-3007 phase 3) —
 * the method bodies that run when the provider is built WITHOUT a burrow
 * client. The burrow daemon is off the spawn path: `create` materializes the
 * workspace warren-side (`src/workspace/materialize.ts`), writes the seed
 * drops itself, composes the sandbox profile (`./profile.ts`), and starts
 * the host-side drive loop (`./drive.ts`) against the warren-owned sandbox
 * (`src/sandbox/`). Events persist DIRECTLY into the in-process run store
 * (`./run-store.ts`) — no daemon, no socket, no HTTP round-trip.
 *
 * Method parity notes:
 *   - `streamEvents` reads the store with the same client-side `sinceSeq`
 *     dedup the burrow stream wrapper did; a missing record rethrows the
 *     provider-neutral `RuntimeRunNotFoundError` exactly as the burrow-404
 *     neutralization did.
 *   - `status` never throws on a missing run: `exists:false` + `lost`, the
 *     §6.7 posture. A warren restart wipes the store just as a burrow
 *     restart wiped the daemon's — reconcile-as-lost is unchanged.
 *   - `terminate` kills a live child, removes the workspace via the
 *     materializer's removal seam, reclaims the per-run HOME, and drops the
 *     manifest — falling back to the on-disk manifest when the store record
 *     is already gone (post-restart GC).
 *   - `finalize` keeps calling the SAME host-side reap merge functions via
 *     `finalizeLocalWorkspace` (`./finalize.ts`) — only the workspace-path
 *     resolution and tracker reads moved off the burrow API.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectProviderEnv } from "../../core/providers.ts";
import type { ReapExec, ReapFs } from "../../runs/reap/types.ts";
import { defaultFs } from "../../runs/reap/util.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import {
	type MaterializedWorkspace,
	materializeProjectWorkspace,
	removeMaterializedWorkspace,
} from "../../workspace/materialize.ts";
import { writeWorkspaceSeedFiles } from "../../workspace/seed-files.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	StreamOpts,
	TeardownResult,
	WorkspaceInfo,
} from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";
import { type DriveDeps, driveLocalRun } from "./drive.ts";
import { finalizeLocalWorkspace } from "./finalize.ts";
import { pinWorkspaceGit, removeRunGitDirs, sealLocalRun, unpinWorkspaceGit } from "./git-pin.ts";
import {
	type LocalRunManifest,
	readLocalRunManifest,
	removeLocalRunManifest,
	writeLocalRunManifest,
} from "./manifest.ts";
import {
	type LocalStateRoots,
	localGitDirPath,
	localHomePath,
	localSandboxId,
	localWorkspacePath,
	resolveLocalStateRoots,
} from "./paths.ts";
import { buildLocalSandboxProfile } from "./profile.ts";
import { LocalRunStore, toNormalizedEvent } from "./run-store.ts";

/**
 * Route Bun's install cache outside the workspace so `git add .` never sweeps
 * it. Provider-owned filesystem-layout env (§6.1).
 */
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";

export interface LocalEngineDeps {
	/** Server-process env — the callback URL derivation + state roots. */
	readonly serverEnv?: EnvLike;
	/** The run store; defaults to a private instance per engine. */
	readonly store?: LocalRunStore;
	/** Disk/shell seam `finalize` runs the reap merge functions over. */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/** Drive-loop seams (tests): spawn / registry / clock. */
	readonly drive?: DriveDeps;
	/**
	 * Preview sidecar registry (warren-4bf3) — `terminate` cascade-deletes
	 * the sandbox's sidecars so a torn-down run never strands a dev server
	 * on a host port. Optional: tests (and the legacy mode) omit it.
	 */
	readonly sidecars?: SidecarCascade;
}

/** The slice of the preview sidecar registry the engine consumes. */
export interface SidecarCascade {
	cascadeDelete(sandboxId: string): Promise<void>;
}

export class LocalEngine {
	private readonly store: LocalRunStore;
	private readonly roots: LocalStateRoots;
	private readonly serverEnv: EnvLike | undefined;

	constructor(private readonly deps: LocalEngineDeps) {
		this.store = deps.store ?? new LocalRunStore();
		this.roots = resolveLocalStateRoots(deps.serverEnv ?? process.env);
		this.serverEnv = deps.serverEnv;
	}

	/**
	 * Provision the workspace and start the drive loop. Materialization
	 * failures throw (the domain rolls the run row back); everything past
	 * materialization terminalizes the run record failed with witness events,
	 * mirroring burrow's enqueue-then-async-fail shape.
	 */
	async create(spec: RunSpec): Promise<RunHandle> {
		if (spec.hostClonePathHint === undefined || spec.hostClonePathHint === "") {
			throw new RuntimeProviderError(
				"LocalProvider.create requires spec.hostClonePathHint (the host clone projectRoot)",
				{
					recoveryHint:
						"the local backend materializes the workspace as a git worktree off the host " +
						"clone; supply hostClonePathHint on the RunSpec (K8s ignores it)",
				},
			);
		}
		const sandboxId = localSandboxId(spec.runId);
		const workspacePath = localWorkspacePath(this.roots, sandboxId);
		const homePath = localHomePath(this.roots, sandboxId);
		await mkdir(homePath, { recursive: true, mode: 0o700 });

		const gitDirPath = localGitDirPath(this.roots, sandboxId);
		const reclaimDirs = async (): Promise<void> => {
			for (const dir of [homePath, workspacePath, gitDirPath]) {
				await rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		};

		let workspace: MaterializedWorkspace;
		try {
			// warren-3c1e: the run gets a private git dir over the host clone's
			// object store, so its branch ref exists only there. The branch starts
			// at baseBranch — which, on a warren-326f existing-branch dispatch
			// (branch === baseBranch), is the branch's own tip. Nothing is carved
			// in or deleted from the host clone.
			workspace = await materializeProjectWorkspace({
				workspacePath,
				branch: spec.branch,
				createBranch: true,
				baseBranch: spec.baseBranch,
				projectRoot: spec.hostClonePathHint,
				privateGitDir: gitDirPath,
				// warren-8926: no originUrl — the clone fallback is refused for
				// local/docker runs (see pinWorkspaceGit), so fail fast instead.
			});
			await writeWorkspaceSeedFiles(workspacePath, spec.seedFiles);
		} catch (err) {
			// Partial-failure cleanup (the rollback posture burrow's provider owned):
			// reclaim the dirs we made and rethrow the ORIGINAL error.
			await reclaimDirs();
			throw err;
		}

		const env = this.composeSandboxEnv(spec.env);
		const frontmatter = readFrontmatterForProfile(spec.metadata);
		let profile: Awaited<ReturnType<typeof buildLocalSandboxProfile>>;
		try {
			// warren-8926/3c1e: validate the private git scope BEFORE the agent
			// runs and pin host-side git for this workspace to it.
			const gitScope = pinWorkspaceGit(workspace.workspacePath, workspace.source);
			profile = await buildLocalSandboxProfile({
				spec,
				env,
				workspace,
				homePath,
				gitScope,
				...(frontmatter !== undefined ? { frontmatter } : {}),
			});
		} catch (err) {
			unpinWorkspaceGit(workspace.workspacePath);
			await removeMaterializedWorkspace({ workspacePath, source: workspace.source }).catch(
				() => {},
			);
			await reclaimDirs();
			throw err;
		}

		const record = this.store.create({
			runId: spec.runId,
			sandboxId,
			workspacePath: workspace.workspacePath,
			homePath,
			branch: spec.branch,
			profile,
		});
		const manifest: LocalRunManifest = {
			version: 1,
			sandboxId,
			runId: spec.runId,
			branch: spec.branch,
			workspacePath: workspace.workspacePath,
			homePath,
			source: workspace.source,
			createdAt: new Date().toISOString(),
		};
		await writeLocalRunManifest(this.roots, manifest).catch(() => {});

		// Fire-and-forget: the drive loop terminalizes the record itself.
		void driveLocalRun(this.store, record, spec, profile, this.deps.drive ?? {});
		return { runId: spec.runId, sandboxId, providerRunId: record.providerRunId };
	}

	/**
	 * Merge the DOMAIN env with the provider's OWN plumbing
	 * (`BUN_INSTALL_CACHE_DIR`).
	 *
	 * warren-fb8d: every provider credential the server env holds (the core
	 * registry's keys, delivered opaquely — the provider does not interpret
	 * them) folds into the sandbox env. The DOMAIN env wins on overlap (an
	 * OAuth-token flow's ANTHROPIC_API_KEY must not be shadowed).
	 *
	 * warren-f737: the run-scoped `WARREN_API_TOKEN` (and the `WARREN_API_URL`
	 * callback it pairs with) never reaches the sandbox. Local and docker runs
	 * have no in-sandbox entrypoint (the harness argv IS the sandboxed
	 * process), and the callbacks the token authorizes (inbox, finalize,
	 * salvage, credential remint) all run host-side in this engine. An agent
	 * holding it could mint a push credential via `/runs/:id/git-credential`,
	 * the hole warren-ccef closed for the K8s agent child.
	 */
	private composeSandboxEnv(domainEnv: Record<string, string>): Record<string, string> {
		return scrubSandboxEnv({
			...collectProviderEnv(this.serverEnv ?? process.env),
			...domainEnv,
			BUN_INSTALL_CACHE_DIR,
		});
	}

	/**
	 * Stream the run's events off the in-process store: replay `seq > sinceSeq`,
	 * then live-follow until the record terminalizes and drains. A missing
	 * record is a ghost run — `RuntimeRunNotFoundError`, the same neutral shape
	 * the burrow-404 neutralization produced.
	 */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return this.pumpEvents(handle.providerRunId, opts?.sinceSeq ?? 0);
	}

	private async *pumpEvents(
		providerRunId: string,
		sinceSeq: number,
	): AsyncGenerator<NormalizedEvent, void, void> {
		const record = this.store.getByRunId(providerRunId);
		if (record === undefined) {
			throw new RuntimeRunNotFoundError(`run ${providerRunId} is unknown to the local backend`, {
				recoveryHint: "the run is unknown to the backend; reconcile the warren row as lost",
			});
		}
		let cursor = sinceSeq;
		for (;;) {
			for (const event of record.events) {
				if (event.seq <= cursor) continue;
				cursor = event.seq;
				yield toNormalizedEvent(event);
			}
			if (this.store.isTerminal(record)) return;
			await this.store.waitForChange(record);
		}
	}

	/** Out-of-band reconcile snapshot. NEVER throws on a missing run (§6.7). */
	status(handle: RunHandle): Promise<RunStatus> {
		const record = this.store.getByRunId(handle.providerRunId);
		if (record === undefined) {
			return Promise.resolve({
				phase: "failed",
				exitCode: null,
				terminalReason: "lost",
				lastEventSeq: 0,
				lastEventTs: null,
				exists: false,
			});
		}
		const last = record.events.at(-1);
		const terminalReason = record.terminalReason;
		return Promise.resolve({
			phase: record.phase,
			exitCode: record.exitCode,
			...(terminalReason !== null ? { terminalReason } : {}),
			lastEventSeq: last?.seq ?? 0,
			lastEventTs: last?.ts ?? null,
			exists: true,
		});
	}

	/**
	 * Enqueue a steering message onto the run's store inbox. The drive loop's
	 * mid-run steering poll delivers it (stdin-held runtimes); a batch runtime
	 * leaves it unread exactly as burrow's next-turn claim did.
	 */
	async sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		const record = this.store.getBySandboxId(handle.sandboxId);
		if (record === undefined) {
			throw new RuntimeRunNotFoundError(
				`sandbox ${handle.sandboxId} is unknown to the local backend`,
				{
					recoveryHint: "the run is likely lost; the bridge will reconcile it to failed",
				},
			);
		}
		const row = this.store.sendMessage(record, msg);
		return {
			id: row.id,
			runId: row.deliveredAtRunId,
			body: row.body,
			priority: row.priority,
			fromActor: row.fromActor,
			state: row.state,
			createdAt: row.createdAt,
			deliveredAt: row.deliveredAt,
		};
	}

	/**
	 * Graceful stop: latch the cancel, kill the live child, and terminalize the
	 * record as `cancelled` immediately (warren-8a6e). Idempotent — an
	 * already-terminal run resolves cleanly, matching burrow's cancel. A ghost
	 * run rethrows `RuntimeRunNotFoundError` (the domain terminalizes the row).
	 *
	 * Immediate terminalization matters: `cancelRun` re-reads `status()` and
	 * only inline-reaps when the phase is already terminal. Waiting on the
	 * drive loop (or the 30s watchdog cancel-reconcile tick) left the warren
	 * row `running` for the full grace window after a local cancel. The drive
	 * loop still owns teardown of the child; it no-ops its own terminalize
	 * once the record is already terminal.
	 */
	async cancel(handle: RunHandle, _reason?: string): Promise<void> {
		const record = this.store.getByRunId(handle.providerRunId);
		if (record === undefined) {
			throw new RuntimeRunNotFoundError(
				`run ${handle.providerRunId} is unknown to the local backend`,
				{ recoveryHint: "the run is unknown to the backend; terminalize the warren row" },
			);
		}
		if (this.store.isTerminal(record)) return;
		record.cancelRequested = true;
		// Terminalize BEFORE killing the child. Order matters (warren-8a6e):
		// killing first can let a late agent `result` envelope land, the bridge
		// detectRuntimeTerminal path reaps `failed`, and cancel's own inline
		// reap then races it. Settling cancelled first means streamEvents ends
		// cleanly and store.terminalize is idempotent against any late write.
		this.store.terminalize(record, {
			phase: "cancelled",
			exitCode: null,
			terminalReason: "cancelled",
			errorMessage: "cancelled",
		});
		record.proc?.cancel();
	}

	/**
	 * Resolve the run's workspace path + branch off the store record (the
	 * in-process replacement for `GET /burrows/:id`). Falls back to the
	 * on-disk manifest so a post-restart finalize can still find the
	 * workspace; throws when neither knows the run (the domain records
	 * `workspace_lookup` and skips the pipeline, as before).
	 */
	async workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo> {
		const record = this.store.getBySandboxId(handle.sandboxId);
		const manifest = await readLocalRunManifest(this.roots, handle.sandboxId);
		// warren-3c1e: reap's host git runs only against the SEALED git dir. Also
		// the post-restart re-pin (warren-8926).
		if (manifest !== null) await sealLocalRun(this.roots, handle.sandboxId, manifest, record?.proc);
		if (record !== undefined) {
			return { workspacePath: record.workspacePath, branch: record.branch };
		}
		if (manifest !== null) {
			return { workspacePath: manifest.workspacePath, branch: manifest.branch };
		}
		throw new RuntimeProviderError(
			`LocalProvider.workspaceInfo: sandbox ${handle.sandboxId} is unknown`,
			{ recoveryHint: "the run is unknown to the backend; reconcile the warren row as lost" },
		);
	}

	/**
	 * Run the workspace-dependent half of reap over the run's live workspace —
	 * the SAME host-side merge functions as the burrow-backed mode, reached via
	 * `finalizeLocalWorkspace` with the store-resolved path and host-FS tracker
	 * reads (the workspace is a local worktree; no daemon file API remains).
	 */
	async finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		const info = await this.workspaceInfo(handle);
		if (info.workspacePath === null) {
			throw new RuntimeProviderError(
				`LocalProvider.finalize: sandbox ${handle.sandboxId} exposed no workspace path`,
				{ recoveryHint: "a run with no workspacePath cannot be finalized" },
			);
		}
		const workspacePath = info.workspacePath;
		const fs = this.deps.fs ?? defaultFs;
		return finalizeLocalWorkspace(
			{
				workspacePath,
				readTracker: (relPath) => fs.readFile(join(workspacePath, relPath)),
			},
			intent,
			{
				...(this.deps.fs !== undefined ? { fs: this.deps.fs } : {}),
				...(this.deps.exec !== undefined ? { exec: this.deps.exec } : {}),
			},
		);
	}

	/**
	 * Kill the sandbox (if live), remove the workspace + per-run HOME, drop
	 * the manifest and the store record. Idempotent and best-effort per step:
	 * the manifest fallback covers a record already lost to a restart, and a
	 * missing manifest still reclaims the deterministic dirs.
	 */
	async terminate(handle: RunHandle): Promise<TeardownResult> {
		const record = this.store.getBySandboxId(handle.sandboxId);
		record?.proc?.cancel();
		// Cascade: terminate every live preview sidecar + release every
		// forward before the workspace they run in disappears (warren-4bf3).
		await this.deps.sidecars?.cascadeDelete(handle.sandboxId).catch(() => undefined);
		const manifest = await readLocalRunManifest(this.roots, handle.sandboxId);
		const workspacePath = record?.workspacePath ?? manifest?.workspacePath ?? null;
		const homePath = record?.homePath ?? manifest?.homePath ?? null;

		if (workspacePath !== null) {
			const source = manifest?.source;
			if (source !== undefined) {
				await removeMaterializedWorkspace({ workspacePath, source }).catch(() => {});
			}
			await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
			unpinWorkspaceGit(workspacePath);
		}
		// Deterministic from the sandbox id: reclaimed even without a manifest.
		await removeRunGitDirs(this.roots, handle.sandboxId);
		if (homePath !== null) {
			await rm(homePath, { recursive: true, force: true }).catch(() => {});
		}
		await removeLocalRunManifest(this.roots, handle.sandboxId).catch(() => {});

		const deletedEvents = record?.events.length ?? 0;
		const deletedMessages = record?.inbox.length ?? 0;
		if (record !== undefined) this.store.remove(record);
		return {
			// No archive: the durable event copy lives in warren's own events
			// table (the domain bridge wrote it), so there is no daemon-side
			// ephemeral store left to archive.
			archived: false,
			deletedEvents,
			deletedMessages,
			deletedRuns: record !== undefined ? 1 : 0,
		};
	}
}

/**
 * Callback-only env keys the sandboxed harness must never inherit
 * (warren-f737). Mirrors the K8s agent-child scrub in `../k8s/agent-io.ts`
 * (warren-ccef): only an in-sandbox entrypoint may hold the run-scoped
 * callback token, and the local and docker paths have none.
 */
const SANDBOX_SCRUBBED_ENV_KEYS: readonly string[] = ["WARREN_API_TOKEN", "WARREN_API_URL"];

/** Drop the callback-only keys from a composed sandbox env. Pure for tests. */
export function scrubSandboxEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!SANDBOX_SCRUBBED_ENV_KEYS.includes(key)) out[key] = value;
	}
	return out;
}

/** Frontmatter reader for the profile's env allowlist (pi provider override). */
function readFrontmatterForProfile(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const raw = metadata?.frontmatter;
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	return raw as Record<string, unknown>;
}
