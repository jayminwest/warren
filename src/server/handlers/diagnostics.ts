/**
 * Diagnostics handlers — `/readyz` (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. The `/healthz` + `/version`
 * inert probes live in `./meta.ts` because they don't need any of the
 * diagnostic checks subsystem.
 */

import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import {
	checkBwrap,
	checkCanopyClean,
	checkCanopyClone,
	checkDatabaseReachable,
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	type DiagnosticCheck,
} from "../../diagnostics/checks.ts";
import { checkStaleBurrowWorkspaces } from "../../diagnostics/stale-workspaces.ts";
import { createRunPreviewsRepo, DEFAULT_MAX_LIVE } from "../../preview/eviction/index.ts";
import { DEFAULT_PREVIEW_PORT_RANGE, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import type { SpawnFn } from "../../projects/clone.ts";
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
		// Canopy probes are gated on `CANOPY_REPO_URL` being configured
		// (warren-d3e9). With no library, both probes return informational
		// `ok: true` rather than failing — built-in agents cover the
		// "no library" case and there's no clone to inspect.
		const env: Readonly<Record<string, string | undefined>> =
			deps.canopyConfig !== undefined
				? {
						CANOPY_REPO_URL: deps.canopyConfig.repoUrl,
						WARREN_CANOPY_DIR: deps.canopyConfig.localDir,
						WARREN_GIT_BINARY: deps.canopyConfig.gitBinary,
					}
				: {};

		const checks: DiagnosticCheck[] = [];
		checks.push(
			await checkDatabaseReachable({ ...(deps.db !== undefined ? { db: deps.db } : {}) }),
		);
		// The burrow socket, bwrap, and stale-burrow-workspace probes only make
		// sense for the local backend, where warren co-tenants a burrow daemon.
		// Under `WARREN_RUNTIME=k8s` there is no burrow at all (agents run in pods),
		// so probing it just reports "burrow unreachable" and needlessly degrades
		// readiness (warren-c128). `burrowReadyzChecks` returns [] under k8s.
		checks.push(...(await burrowReadyzChecks(deps, spawn)));
		checks.push(await checkAgentsRegistered(deps));
		checks.push(checkCanopyClone({ env }));
		checks.push(await checkCanopyClean({ env, spawn }));
		const warrenConfigProjects = (await deps.repos.projects.listAll()).map((p) => ({
			id: p.id,
			localPath: p.localPath,
		}));
		const warrenConfigArgs = {
			projects: warrenConfigProjects,
			...(deps.warrenConfigs !== undefined ? { cache: deps.warrenConfigs } : {}),
		};
		checks.push(await checkWarrenConfig(warrenConfigArgs));
		checks.push(await checkWarrenConfigDeprecations(warrenConfigArgs));
		checks.push(await previewPortAllocatorReadyzCheck(deps));
		checks.push(await previewMaxLiveReadyzCheck(deps));
		// Auth-strength probe (R-19 / SPEC §11.L, warren-8a10) reads from
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
 * The burrow-specific readyz probes — socket reachability, bwrap bring-up, and
 * stale burrow workspaces. Only meaningful under the local backend: the K8s
 * runtime (`WARREN_RUNTIME=k8s`) runs agents in pods with no co-tenanted burrow
 * daemon, so these would only ever report "burrow unreachable" and degrade an
 * otherwise-healthy control plane (warren-c128). Returns `[]` under k8s. Reads
 * `WARREN_RUNTIME` off `process.env` directly, mirroring the auth-strength probe
 * above (server boot already validated the value via `resolveRuntimeProvider`).
 */
async function burrowReadyzChecks(deps: ServerDeps, spawn: SpawnFn): Promise<DiagnosticCheck[]> {
	if (resolveRuntimeKind() !== "local") return [];
	// warren-f796: the burrow-socket probe is a boot-wired thunk (`deps.burrowProbe`,
	// built by the `LocalBootBackend`) rather than a `burrowClient` on ServerDeps.
	// Tests that omit it degrade to just the bwrap + stale-workspace probes.
	const burrowProbe = deps.burrowProbe;
	return [
		...(burrowProbe !== undefined ? [await burrowProbe()] : []),
		await checkBwrap({ spawn }),
		await staleBurrowWorkspacesReadyzCheck(deps),
	];
}

async function previewPortAllocatorReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// Range is resolved at boot (`ServerDeps.previewPortRange`) so /readyz
	// doesn't re-parse env per request. Tests omit deps.previewPortRange;
	// fall back to defaults so the probe still exercises the codepath.
	const range = deps.previewPortRange ?? DEFAULT_PREVIEW_PORT_RANGE;
	if (deps.db === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	const allocator = new PreviewPortAllocator(DrizzleAdapter.for(deps.db), range);
	return checkPreviewPortAllocator({ probe: allocator });
}

async function previewMaxLiveReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	const maxLive = deps.previewMaxLive ?? DEFAULT_MAX_LIVE;
	if (deps.db === undefined) {
		return {
			name: "preview_max_live",
			ok: true,
			message: `no db handle wired (cap ${maxLive})`,
		};
	}
	const previews = createRunPreviewsRepo(deps.db);
	return checkPreviewMaxLive({
		probe: { count: () => previews.countActivePreviews() },
		maxLive,
	});
}

async function staleBurrowWorkspacesReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// TTL is resolved at boot (`ServerDeps.workspaceGcTtlMs`). Tests omit it;
	// degrade to an informational `ok: true` rather than guessing a TTL.
	if (deps.workspaceGcTtlMs === undefined) {
		return {
			name: "stale_burrow_workspaces",
			ok: true,
			message: "workspace GC TTL not wired",
		};
	}
	return checkStaleBurrowWorkspaces({
		probe: {
			listByState: (state) => deps.repos.runs.listByState(state),
		},
		ttlMs: deps.workspaceGcTtlMs,
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
			hint:
				deps.canopyConfig !== undefined
					? "POST /agents/refresh against your canopy library, or check the warren server logs for built-in seed errors"
					: "check the warren server logs for built-in seed errors",
		};
	}
	return { name: "agents", ok: true };
}
