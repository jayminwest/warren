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
import { loopbackApiUrl } from "../../runs/spawn/callback-env.ts";
import { branchExists, discoverHostClone } from "../../workspace/git/worktree.ts";
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
import {
	type LocalRunManifest,
	readLocalRunManifest,
	removeLocalRunManifest,
	writeLocalRunManifest,
} from "./manifest.ts";
import {
	type LocalStateRoots,
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

		let workspace: MaterializedWorkspace;
		try {
			// warren-326f: an existing-branch dispatch pins branch === baseBranch and
			// the branch already exists locally (the refresh checked it out) and on
			// the remote. Carving it with `-b` would fail; a non-detached checkout
			// would collide with the host clone's HEAD — so check out detached when
			// the branch pre-exists, and never delete it at teardown (it predates
			// the run). Every other dispatch takes the untouched carve path.
			let checkoutExisting = false;
			if (spec.branch === spec.baseBranch) {
				const hostClone = await discoverHostClone(spec.hostClonePathHint);
				checkoutExisting =
					hostClone !== null && (await branchExists(hostClone.topLevel, spec.branch));
			}
			workspace = await materializeProjectWorkspace({
				workspacePath,
				branch: spec.branch,
				...(checkoutExisting ? { detached: true as const } : { createBranch: true as const }),
				baseBranch: spec.baseBranch,
				projectRoot: spec.hostClonePathHint,
				originUrl: spec.originUrl,
			});
			await writeWorkspaceSeedFiles(workspacePath, spec.seedFiles);
		} catch (err) {
			// Partial-failure cleanup (the rollback posture burrow's provider owned):
			// reclaim the dirs we made and rethrow the ORIGINAL error.
			await rm(homePath, { recursive: true, force: true }).catch(() => {});
			await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
			throw err;
		}

		const env = this.composeSandboxEnv(spec.env);
		const frontmatter = readFrontmatterForProfile(spec.metadata);
		const profile = await buildLocalSandboxProfile({
			spec,
			env,
			workspace,
			homePath,
			...(frontmatter !== undefined ? { frontmatter } : {}),
		});

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
	 * (`BUN_INSTALL_CACHE_DIR` + the computed `WARREN_API_URL` callback, §6.3).
	 * Unchanged from the burrow-backed mode: the callback URL rides only when
	 * the domain supplied a token.
	 *
	 * warren-fb8d: every provider credential the server env holds (the core
	 * registry's keys, delivered opaquely — the provider does not interpret
	 * them) folds into the sandbox env. The DOMAIN env wins on overlap (an
	 * OAuth-token flow's ANTHROPIC_API_KEY must not be shadowed).
	 */
	private composeSandboxEnv(domainEnv: Record<string, string>): Record<string, string> {
		const env: Record<string, string> = {
			...collectProviderEnv(this.serverEnv ?? process.env),
			...domainEnv,
			BUN_INSTALL_CACHE_DIR,
		};
		const token = domainEnv.WARREN_API_TOKEN;
		if (token !== undefined && token !== "") {
			const url = loopbackApiUrl(this.serverEnv ?? process.env);
			if (url !== null) env.WARREN_API_URL = url;
		}
		return env;
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
		if (record !== undefined) {
			return { workspacePath: record.workspacePath, branch: record.branch };
		}
		const manifest = await readLocalRunManifest(this.roots, handle.sandboxId);
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
		}
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
