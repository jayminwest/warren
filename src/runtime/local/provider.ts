/**
 * `LocalProvider` — the self-host / single-container `RuntimeProvider`
 * (contract in `../contract.ts`).
 *
 * As of warren-ea0a (plan pl-3007 phase 3) the provider is IN-PROCESS only:
 * it spawns agents through the warren-owned sandbox (`src/sandbox/`,
 * warren-5af7) driven by the host-side drive loop (`./drive.ts`, shaped on
 * the k8s in-pod entrypoint, warren-0efe). Workspaces materialize warren-side
 * (`src/workspace/materialize.ts`); events persist directly into the
 * in-process run store (`./run-store.ts`). Method bodies live in
 * `./engine.ts` (`LocalEngine`). The legacy burrow-backed mode — and the
 * `src/burrow-client/` facade it wrapped — are deleted.
 *
 * `finalize` runs the SAME host-side reap merge functions the legacy mode
 * did — only the workspace-path resolution + tracker reads differ (run store
 * + host FS); `src/runs/reap/**` is untouched.
 */

import type { ReapExec, ReapFs } from "../../runs/reap/types.ts";
import type { EnvLike } from "../../runs/spawn/callback-env.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
	WorkspaceInfo,
} from "../contract.ts";
import type { DriveDeps } from "./drive.ts";
import { LocalEngine, type SidecarCascade } from "./engine.ts";
import type { LocalRunStore } from "./run-store.ts";

/** Dependencies the provider methods wrap. */
export interface LocalProviderDeps {
	/**
	 * Server-process env the provider reads to compute its OWN plumbing — the
	 * loopback callback URL (`WARREN_API_URL`, §6.3) and the on-disk state
	 * roots (`WARREN_DATA_DIR`). Defaults to `process.env`.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * Disk/shell seam `finalize()` runs the reap merge functions over. Defaults
	 * to the real `defaultFs` / `defaultExec` (`src/runs/reap/util.ts`).
	 */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/**
	 * OPTIONAL shared run store — tests inject one to drive records directly;
	 * production uses the provider's private default.
	 */
	readonly store?: LocalRunStore;
	/** OPTIONAL drive-loop seams (tests): spawn / registry. */
	readonly drive?: DriveDeps;
	/**
	 * OPTIONAL preview sidecar cascade (warren-4bf3) — `terminate`
	 * cascade-deletes the sandbox's sidecars through it. Boot threads the
	 * warren-owned registry; tests omit it.
	 */
	readonly sidecars?: SidecarCascade;
}

/**
 * The local feature set. LocalProvider is the reference backend, so every
 * capability is at its strongest: all booleans `true` and the per-domain
 * network allowlist (design doc §5 — the K8s v1 backend degrades several of
 * these, e.g. `networkPolicy: "coarse"`). Frozen so the domain can read but
 * never mutate a provider's advertised capabilities.
 */
export const LOCAL_PROVIDER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	previewPorts: true,
	networkPolicy: "domain-allowlist",
	longLived: true,
	midRunSteering: true,
	enforcedResourceLimits: true,
	workspaceArchive: true,
	workspaceGc: true,
});

export class LocalProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = LOCAL_PROVIDER_CAPABILITIES;
	readonly kind = "local" as const;

	private readonly engine: LocalEngine;

	constructor(deps: LocalProviderDeps = {}) {
		this.engine = new LocalEngine({
			...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
			...(deps.store !== undefined ? { store: deps.store } : {}),
			...(deps.fs !== undefined ? { fs: deps.fs } : {}),
			...(deps.exec !== undefined ? { exec: deps.exec } : {}),
			...(deps.drive !== undefined ? { drive: deps.drive } : {}),
			...(deps.sidecars !== undefined ? { sidecars: deps.sidecars } : {}),
		});
	}

	/**
	 * Create a run: materialize the workspace, compose the sandbox profile,
	 * and start the drive loop (`./engine.ts`).
	 */
	create(spec: RunSpec): Promise<RunHandle> {
		return this.engine.create(spec);
	}

	/** Ordered, resumable, lossless event stream (see ./engine.ts). */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return this.engine.streamEvents(handle, opts);
	}

	/** Out-of-band reconcile snapshot; never throws on a missing run (§6.7). */
	status(handle: RunHandle): Promise<RunStatus> {
		return this.engine.status(handle);
	}

	/** Enqueue a steering message (see ./engine.ts). */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		return this.engine.sendMessage(handle, msg);
	}

	/** Graceful stop — distinct from `terminate` (see ./engine.ts). */
	cancel(handle: RunHandle, reason?: string): Promise<void> {
		return this.engine.cancel(handle, reason);
	}

	/** Resolve the run's workspace path + push branch (warren-e9e1). */
	workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo> {
		return this.engine.workspaceInfo(handle);
	}

	/**
	 * Run the workspace-DEPENDENT half of reap over the run's live workspace
	 * (§4) — the same host-side merge functions the legacy mode ran; only the
	 * workspace resolution differs (see ./engine.ts).
	 */
	finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		return this.engine.finalize(handle, intent);
	}

	/** Kill the sandbox, reclaim the workspace + HOME, drop state (see ./engine.ts). */
	terminate(handle: RunHandle): Promise<TeardownResult> {
		return this.engine.terminate(handle);
	}
}
