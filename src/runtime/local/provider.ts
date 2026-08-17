/**
 * `LocalProvider` — the self-host / single-container `RuntimeProvider`
 * (contract in `../contract.ts`).
 *
 * As of warren-413d (plan pl-3007 phase 3) the provider runs in TWO modes,
 * selected by whether a burrow client is wired:
 *
 *   - IN-PROCESS (production): built WITHOUT a burrow client, it spawns
 *     agents through the warren-owned sandbox (`src/sandbox/`, warren-5af7)
 *     driven by the host-side drive loop (`./drive.ts`, shaped on the k8s
 *     in-pod entrypoint, warren-0efe). Workspaces materialize warren-side
 *     (`src/workspace/materialize.ts`); events persist directly into the
 *     in-process run store (`./run-store.ts`). The burrow daemon is OFF the
 *     spawn path. Method bodies live in `./engine.ts` (`LocalEngine`).
 *
 *   - LEGACY (transition): built WITH a burrow client, every method wraps
 *     the `src/burrow-client/` facade exactly as before (./stream.ts,
 *     ./status.ts, ./cancel.ts, ./send-message.ts, ./teardown.ts,
 *     ./workspace-info.ts, ./legacy-create.ts). The server boot no longer
 *     wires a client in; the mode survives for the test harnesses
 *     (`src/runs/reap/test-helpers.ts` drives finalize through a fake
 *     client) and leaves with the daemon teardown (warren-9a26/warren-ea0a).
 *
 * `finalize` runs the SAME host-side reap merge functions in both modes —
 * only the workspace-path resolution + tracker reads differ (burrow API vs
 * store + host FS); `src/runs/reap/**` is untouched.
 */

import type { BurrowClient } from "../../burrow-client/index.ts";
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
import { cancelLocalRun } from "./cancel.ts";
import type { DriveDeps } from "./drive.ts";
import { LocalEngine, type SidecarCascade } from "./engine.ts";
import { finalizeLocalRun } from "./finalize.ts";
import { legacyCreate } from "./legacy-create.ts";
import type { LocalRunStore } from "./run-store.ts";
import { sendLocalMessage } from "./send-message.ts";
import { localRunStatus } from "./status.ts";
import { streamLocalEvents } from "./stream.ts";
import { terminateLocalRun } from "./teardown.ts";
import { localWorkspaceInfo } from "./workspace-info.ts";

/** Dependencies the provider methods wrap. */
export interface LocalProviderDeps {
	/**
	 * OPTIONAL burrow client factory. PRESENT ⇒ legacy burrow-backed mode
	 * (tests + the transition); ABSENT ⇒ the in-process engine (production
	 * boot, warren-413d). A factory so the provider can be built before — or
	 * without — a live client.
	 */
	readonly burrowClient?: () => BurrowClient;
	/**
	 * Server-process env the provider reads to compute its OWN plumbing — the
	 * loopback callback URL (`WARREN_API_URL`, §6.3) and, in-process mode, the
	 * on-disk state roots (`WARREN_DATA_DIR`). Defaults to `process.env`.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * Disk/shell seam `finalize()` runs the reap merge functions over. Defaults
	 * to the real `defaultFs` / `defaultExec` (`src/runs/reap/util.ts`).
	 */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/**
	 * OPTIONAL shared run store (in-process mode) — tests inject one to drive
	 * records directly; production uses the provider's private default.
	 */
	readonly store?: LocalRunStore;
	/** OPTIONAL drive-loop seams (in-process mode tests): spawn / registry. */
	readonly drive?: DriveDeps;
	/**
	 * OPTIONAL preview sidecar cascade (in-process mode, warren-4bf3) —
	 * `terminate` cascade-deletes the sandbox's sidecars through it. Boot
	 * threads the warren-owned registry; tests omit it.
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

	/** In-process engine — null in legacy (burrow-client) mode. */
	private readonly engine: LocalEngine | null;

	constructor(private readonly deps: LocalProviderDeps) {
		this.engine =
			deps.burrowClient === undefined
				? new LocalEngine({
						...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
						...(deps.store !== undefined ? { store: deps.store } : {}),
						...(deps.fs !== undefined ? { fs: deps.fs } : {}),
						...(deps.exec !== undefined ? { exec: deps.exec } : {}),
						...(deps.drive !== undefined ? { drive: deps.drive } : {}),
						...(deps.sidecars !== undefined ? { sidecars: deps.sidecars } : {}),
					})
				: null;
	}

	private legacyClient(): BurrowClient {
		// Callers only reach the legacy bodies when a client factory was wired
		// (engine === null); the non-null assertion is that mode check.
		const factory = this.deps.burrowClient;
		if (factory === undefined) {
			throw new Error("LocalProvider: no burrow client wired (in-process mode)");
		}
		return factory();
	}

	/**
	 * Create a run. In-process mode materializes the workspace + starts the
	 * drive loop (`./engine.ts`); legacy mode collapses burrow's two calls
	 * (`./legacy-create.ts`).
	 */
	create(spec: RunSpec): Promise<RunHandle> {
		if (this.engine !== null) return this.engine.create(spec);
		return legacyCreate(this.legacyClient(), spec, this.deps.serverEnv);
	}

	/** Ordered, resumable, lossless event stream (see ./engine.ts / ./stream.ts). */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		if (this.engine !== null) return this.engine.streamEvents(handle, opts);
		return streamLocalEvents(this.legacyClient(), handle.providerRunId, opts);
	}

	/** Out-of-band reconcile snapshot; never throws on a missing run (§6.7). */
	status(handle: RunHandle): Promise<RunStatus> {
		if (this.engine !== null) return this.engine.status(handle);
		return localRunStatus(this.legacyClient(), handle);
	}

	/** Enqueue a steering message (see ./engine.ts / ./send-message.ts). */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		if (this.engine !== null) return this.engine.sendMessage(handle, msg);
		return sendLocalMessage(this.legacyClient(), handle, msg);
	}

	/** Graceful stop — distinct from `terminate` (see ./engine.ts / ./cancel.ts). */
	cancel(handle: RunHandle, reason?: string): Promise<void> {
		if (this.engine !== null) return this.engine.cancel(handle, reason);
		return cancelLocalRun(this.legacyClient(), handle, reason);
	}

	/** Resolve the run's workspace path + push branch (warren-e9e1). */
	workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo> {
		if (this.engine !== null) return this.engine.workspaceInfo(handle);
		return localWorkspaceInfo(this.legacyClient(), handle);
	}

	/**
	 * Run the workspace-DEPENDENT half of reap over the run's live workspace
	 * (§4) — the same host-side merge functions in both modes; only the
	 * workspace resolution differs (see ./finalize.ts).
	 */
	finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		if (this.engine !== null) return this.engine.finalize(handle, intent);
		return finalizeLocalRun(this.legacyClient(), handle, intent, {
			...(this.deps.fs !== undefined ? { fs: this.deps.fs } : {}),
			...(this.deps.exec !== undefined ? { exec: this.deps.exec } : {}),
		});
	}

	/** Kill the sandbox, reclaim the workspace + HOME, drop state (see ./engine.ts / ./teardown.ts). */
	terminate(handle: RunHandle): Promise<TeardownResult> {
		if (this.engine !== null) return this.engine.terminate(handle);
		return terminateLocalRun(this.legacyClient(), handle);
	}
}
