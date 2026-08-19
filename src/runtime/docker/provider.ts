/**
 * `DockerProvider` — the sibling-container `RuntimeProvider`
 * (`WARREN_RUNTIME=docker`, warren-3732, plan pl-3007 phase 4). Each agent
 * runs as a SIBLING CONTAINER over the docker socket: the container
 * boundary IS the sandbox, so nested bwrap and the compose file's
 * apparmor/seccomp/SYS_ADMIN flags are optional for docker-topology
 * self-hosters. Design record: `docs/design/runtime-docker-provider.md`.
 *
 * Implementation posture: the provider is a thin wrapper over the
 * in-process `LocalEngine` (`src/runtime/local/engine.ts`). The workspace
 * materializes warren-side exactly as the local backend does (a git
 * worktree off the host clone), the host-side drive loop reuses the
 * phase-2 adapters and their parsers, events persist into the same
 * in-process run store, and `finalize` runs the SAME host-side reap merge
 * functions — the workspace is a bind-mounted host path, so the control
 * plane reaches it directly (no in-container finalize round-trip like the
 * K8s backend needs). The ONLY substituted seam is the drive loop's spawn:
 * `makeDockerSpawn` (`./spawn.ts`) runs the adapter command inside the
 * container instead of bwrap.
 *
 * Honest capability degradations relative to LocalProvider (contract §5):
 * no domain-allowlist network policy at v1 (coarse docker networks only),
 * no preview sidecars (they spawn through bwrap profiles), no workspace
 * archive handle.
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
import { LocalEngine, type SidecarCascade } from "../local/engine.ts";
import type { LocalRunStore } from "../local/run-store.ts";
import { type DockerSpawnDeps, makeDockerSpawn } from "./spawn.ts";

/** Dependencies the provider wraps. */
export interface DockerProviderDeps {
	/** Server-process env — callback URL derivation, state roots, docker config. */
	readonly serverEnv?: EnvLike;
	/** Disk/shell seam `finalize()` runs the reap merge functions over. */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/** OPTIONAL shared run store (boot threads the preview registry's store). */
	readonly store?: LocalRunStore;
	/**
	 * OPTIONAL preview sidecar cascade. Accepted for boot-shape parity with
	 * the local backend; the docker topology advertises `previewPorts:
	 * false`, so no sidecars ever register and the cascade is a no-op.
	 */
	readonly sidecars?: SidecarCascade;
	/** OPTIONAL docker spawn seams (tests inject a scripted docker CLI). */
	readonly docker?: DockerSpawnDeps;
}

/**
 * The docker v1 feature set (contract doc §5), frozen:
 *
 *   - `previewPorts: false` — preview sidecars spawn through bwrap profiles;
 *     no docker-topology wiring at v1.
 *   - `networkPolicy: "coarse"` — `none` maps to `--network none`, but
 *     `restricted` degrades to a docker network (no per-domain allowlist).
 *   - `longLived: true` / `midRunSteering: true` — the container's stdin
 *     pipes through the docker CLI, so the stdin-hold + live-steering
 *     contract holds exactly as under bwrap.
 *   - `enforcedResourceLimits: true` — `--memory` / `--cpus` are real
 *     daemon-enforced cgroup limits, with the OOMKilled inspect probe.
 *   - `workspaceArchive: false` — terminate returns no archive handle.
 *   - `workspaceGc: true` — workspaces are host dirs under the same state
 *     roots as the local backend, so the fallback sweep reclaims them
 *     through the same destroy seam.
 */
export const DOCKER_PROVIDER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	previewPorts: false,
	networkPolicy: "coarse",
	longLived: true,
	midRunSteering: true,
	enforcedResourceLimits: true,
	workspaceArchive: false,
	workspaceGc: true,
});

export class DockerProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = DOCKER_PROVIDER_CAPABILITIES;
	readonly kind = "docker" as const;

	private readonly engine: LocalEngine;

	constructor(deps: DockerProviderDeps = {}) {
		const serverEnv = deps.serverEnv ?? process.env;
		this.engine = new LocalEngine({
			serverEnv,
			...(deps.store !== undefined ? { store: deps.store } : {}),
			...(deps.fs !== undefined ? { fs: deps.fs } : {}),
			...(deps.exec !== undefined ? { exec: deps.exec } : {}),
			...(deps.sidecars !== undefined ? { sidecars: deps.sidecars } : {}),
			drive: {
				spawn: makeDockerSpawn({ env: serverEnv, ...(deps.docker ?? {}) }),
			},
		});
	}

	/** Create a run: materialize the worktree, spawn the agent container. */
	create(spec: RunSpec): Promise<RunHandle> {
		return this.engine.create(spec);
	}

	/** Ordered, resumable, lossless event stream (see local/engine.ts). */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return this.engine.streamEvents(handle, opts);
	}

	/** Out-of-band reconcile snapshot; never throws on a missing run (§6.7). */
	status(handle: RunHandle): Promise<RunStatus> {
		return this.engine.status(handle);
	}

	/** Enqueue a steering message (live-stdin delivery, see local/engine.ts). */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		return this.engine.sendMessage(handle, msg);
	}

	/** Graceful stop — force-removes the container via the spawn seam's cancel. */
	cancel(handle: RunHandle, reason?: string): Promise<void> {
		return this.engine.cancel(handle, reason);
	}

	/** Resolve the run's host workspace path + push branch. */
	workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo> {
		return this.engine.workspaceInfo(handle);
	}

	/** Host-side reap merge over the bind-mounted workspace (contract §4). */
	finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		return this.engine.finalize(handle, intent);
	}

	/** Kill the container, reclaim the workspace + HOME, drop state. */
	terminate(handle: RunHandle): Promise<TeardownResult> {
		return this.engine.terminate(handle);
	}
}
