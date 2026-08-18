/**
 * Diagnostics handlers — `/readyz` (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. The `/healthz` + `/version`
 * inert probes live in `./meta.ts` because they don't need any of the
 * diagnostic checks subsystem.
 */

import {
	checkBwrap,
	checkDatabaseReachable,
	checkDockerCli,
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	type DiagnosticCheck,
} from "../../diagnostics/checks.ts";
import { checkStaleSandboxWorkspaces } from "../../diagnostics/stale-workspaces.ts";
import { DEFAULT_MAX_LIVE } from "../../preview/eviction/index.ts";
import { DEFAULT_PREVIEW_PORT_RANGE, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { resolveDockerConfig } from "../../runtime/docker/config.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { defaultSpawn } from "./index.ts";

export function readyzHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		// SpawnFn is required for the bwrap + canopy_clean probes; main.ts
		// always wires `defaultSpawn`, but the type system keeps it
		// optional so tests don't have to populate it. Fall back to the
		// handler-local `defaultSpawn` to keep the contract live in tests
		// that don't override.
		const spawn: SpawnFn = deps.spawn ?? defaultSpawn;

		const checks: DiagnosticCheck[] = [];
		// `deps.logger` is the sink for the raw failure detail the checks
		// refuse to put in the payload (warren-51de): driver text naming the
		// DB host/port/role, loader text naming the clone's absolute path.
		// The body carries a stable reason code; the log carries the rest.
		checks.push(
			await checkDatabaseReachable({
				...(deps.db !== undefined ? { db: deps.db } : {}),
				log: deps.logger,
			}),
		);
		// The bwrap and stale-workspace probes only make sense for the local
		// backend, where warren runs sandboxes in-process on the host (warren-413d).
		// The co-tenanted burrow daemon is gone (warren-9a26), so its socket probe
		// is gone with it. Under `WARREN_RUNTIME=k8s` agents run in pods and bwrap
		// runs inside the agent image, so probing it here just reports "bwrap not
		// found" and needlessly degrades readiness (warren-c128).
		// `localReadyzChecks` returns [] under k8s.
		checks.push(...(await localReadyzChecks(deps, spawn)));
		// The docker-topology counterpart (warren-5c42): under
		// `WARREN_RUNTIME=docker` the one binary a dispatch cannot proceed
		// without is the docker CLI, so readiness execs it. Returns [] on the
		// other backends.
		checks.push(...(await dockerReadyzChecks(spawn)));
		// The K8s-topology counterpart (warren-39e1): under `WARREN_RUNTIME=k8s`
		// /readyz asserts something POSITIVE about the control plane — the pod
		// watcher's informer sync state — rather than just skipping the burrow
		// probes. Returns null under `local` so the check is absent there.
		const k8sCheck = k8sApiReachableReadyzCheck(deps);
		if (k8sCheck !== null) checks.push(k8sCheck);
		checks.push(await checkAgentsRegistered(deps));
		const warrenConfigProjects = (await deps.repos.projects.listAll()).map((p) => ({
			id: p.id,
			localPath: p.localPath,
		}));
		const warrenConfigArgs = {
			projects: warrenConfigProjects,
			log: deps.logger,
			...(deps.warrenConfigs !== undefined ? { cache: deps.warrenConfigs } : {}),
		};
		checks.push(await checkWarrenConfig(warrenConfigArgs));
		checks.push(await checkWarrenConfigDeprecations(warrenConfigArgs));
		checks.push(await previewPortAllocatorReadyzCheck(deps));
		checks.push(await previewMaxLiveReadyzCheck(deps));
		// Auth-strength probe (R-19 / docs/design/preview-environments.md, warren-8a10) reads from
		// process.env directly: server boot already validated the token shape,
		// so /readyz only needs to surface the strength heuristic against the
		// live env. Tests that don't override `process.env` get the inert
		// "preview disabled" branch.
		checks.push(checkPreviewAuthStrength({ env: process.env }));

		const allOk = checks.every((c) => c.ok);
		return jsonResponse(allOk ? 200 : 503, {
			ok: allOk,
			checks,
		});
	};
}

/**
 * The local-topology readyz probes — bwrap bring-up and stale workspaces.
 * Only meaningful under the local backend, where warren itself execs bwrap
 * for the in-process sandbox engine (warren-413d): the K8s runtime
 * (`WARREN_RUNTIME=k8s`) runs agents in pods and bwrap lives in the agent
 * image, so probing it here would only ever report "bwrap not found" and
 * degrade an otherwise-healthy control plane (warren-c128). The burrow-daemon
 * socket probe died with the daemon (warren-9a26). Returns `[]` under k8s.
 * Reads `WARREN_RUNTIME` off `process.env` directly, mirroring the
 * auth-strength probe above (server boot already validated the value via
 * `resolveRuntimeProvider`).
 */
async function localReadyzChecks(deps: ServerDeps, spawn: SpawnFn): Promise<DiagnosticCheck[]> {
	if (resolveRuntimeKind() !== "local") return [];
	return [
		await checkBwrap({
			spawn,
			...(deps.platform !== undefined ? { platform: deps.platform } : {}),
		}),
		await staleSandboxWorkspacesReadyzCheck(deps),
	];
}

/**
 * The docker-topology readyz probe — `docker_cli` (warren-5c42). Scoped the
 * same way as the local bwrap probe (warren-c128): only the sibling-container
 * backend needs a docker CLI, so on `local` / `k8s` there is nothing to probe
 * and the check is absent. A broken CLI used to boot green and surface only
 * at the first dispatch, as `Executable not found in $PATH: "docker"` — the
 * macOS Docker Desktop bind-mount trap in particular (see
 * `DOCKER_CLI_HINT`). Reads `WARREN_RUNTIME` and `WARREN_DOCKER_BIN` off
 * `process.env` directly, mirroring `localReadyzChecks` — boot already
 * validated the runtime value via `resolveRuntimeProvider`, and the spawn
 * seam resolves its own config from the same env.
 */
async function dockerReadyzChecks(spawn: SpawnFn): Promise<DiagnosticCheck[]> {
	if (resolveRuntimeKind() !== "docker") return [];
	return [await checkDockerCli({ spawn, dockerBin: resolveDockerConfig(process.env).bin })];
}

/**
 * The K8s-topology readiness probe (warren-39e1): `k8s_api_reachable`. Under
 * `WARREN_RUNTIME=k8s` the burrow probes are scoped out (warren-c128), so
 * without this check /readyz asserted nothing positive about the K8s control
 * plane — a warren pod with a broken API-server connection would report
 * ready. The probe reads the pod-watcher informer's sync state (its
 * `isSynced()` seam): synced means the informer has listed against the API
 * server and holds a live watch; unsynced means the API is unreachable or the
 * stream is down. Returns `null` under `local` — the check is absent there.
 */
function k8sApiReachableReadyzCheck(deps: ServerDeps): DiagnosticCheck | null {
	if (resolveRuntimeKind() !== "k8s") return null;
	const sync = deps.k8sPodSync;
	if (sync === undefined) {
		return {
			name: "k8s_api_reachable",
			ok: false,
			message: "pod watcher not wired",
			hint: "the K8s runtime backend must start the pod watcher before serving",
		};
	}
	if (!sync.isSynced()) {
		return {
			name: "k8s_api_reachable",
			ok: false,
			message: "pod watcher not synced with the K8s API server",
			hint: "check API-server reachability from this pod (service account, network policy)",
		};
	}
	return { name: "k8s_api_reachable", ok: true };
}

async function previewPortAllocatorReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// Range is resolved at boot (`ServerDeps.previewPortRange`) so /readyz
	// doesn't re-parse env per request. Tests omit deps.previewPortRange;
	// fall back to defaults so the probe still exercises the codepath.
	const range = deps.previewPortRange ?? DEFAULT_PREVIEW_PORT_RANGE;
	if (deps.dbAdapter === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	const allocator = new PreviewPortAllocator(deps.dbAdapter, range);
	return checkPreviewPortAllocator({ probe: allocator, log: deps.logger });
}

async function previewMaxLiveReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	const maxLive = deps.previewMaxLive ?? DEFAULT_MAX_LIVE;
	const previews = deps.runPreviews;
	if (previews === undefined) {
		return {
			name: "preview_max_live",
			ok: true,
			message: `no db handle wired (cap ${maxLive})`,
		};
	}
	return checkPreviewMaxLive({
		probe: { count: () => previews.countActivePreviews() },
		maxLive,
		log: deps.logger,
	});
}

async function staleSandboxWorkspacesReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// TTL is resolved at boot (`ServerDeps.workspaceGcTtlMs`). Tests omit it;
	// degrade to an informational `ok: true` rather than guessing a TTL.
	if (deps.workspaceGcTtlMs === undefined) {
		return {
			name: "stale_sandbox_workspaces",
			ok: true,
			message: "workspace GC TTL not wired",
		};
	}
	return checkStaleSandboxWorkspaces({
		probe: {
			listByState: (state) => deps.repos.runs.listByState(state),
		},
		ttlMs: deps.workspaceGcTtlMs,
		log: deps.logger,
		...(deps.now !== undefined ? { now: deps.now() } : {}),
	});
}

async function checkAgentsRegistered(deps: ServerDeps): Promise<DiagnosticCheck> {
	const count = (await deps.repos.agents.listAll()).length;
	if (count === 0) {
		// Built-ins seed on boot (warren-d3e9), so an empty registry here
		// means seeding itself failed — an internal problem, not an
		// operator one. Keep the failure but reword the hint accordingly.
		return {
			name: "agents",
			ok: false,
			message: "no agents registered",
			hint: "check the warren server logs for built-in seed errors",
		};
	}
	return { name: "agents", ok: true };
}
