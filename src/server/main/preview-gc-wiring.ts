/**
 * Preview + workspace-GC seam wiring (warren-e24d). Both are LocalProvider-only
 * capabilities whose burrow coupling lives under `src/runtime/local/`. Extracted
 * from `bootServer` so the orchestrator stays under its file-size budget.
 *
 * Gate on the provider's advertised capabilities: under a backend without
 * preview ports / workspace-GC (K8s) these stay `undefined`, so the reap preview
 * sub-step + eviction/teardown sidecar stop + fallback GC sweep all go dark
 * exactly as they do today for a project without preview config (the K8s pod-GC
 * loop reclaims stranded workspaces on its own).
 */

import type { BurrowClient } from "../../burrow-client/index.ts";
import type { WorkspaceDestroyer } from "../../runs/reap/gc.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import {
	createLocalSidecarsResolver,
	type LocalSidecarsResolver,
} from "../../runtime/local/preview/sidecars.ts";
import { createLocalWorkspaceDestroyer } from "../../runtime/local/workspace-gc.ts";

export interface LocalPreviewGcSeams {
	/** Preview sidecar resolver (present iff `capabilities.previewPorts`). */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Stranded-workspace destroyer (present iff `capabilities.workspaceGc`). */
	readonly workspaceDestroyer?: WorkspaceDestroyer;
}

export function resolveLocalPreviewGcSeams(
	runtimeProvider: RuntimeProvider,
	burrowClient: BurrowClient,
): LocalPreviewGcSeams {
	return {
		...(runtimeProvider.capabilities.previewPorts
			? { previewSidecars: createLocalSidecarsResolver(burrowClient) }
			: {}),
		...(runtimeProvider.capabilities.workspaceGc
			? { workspaceDestroyer: createLocalWorkspaceDestroyer(burrowClient) }
			: {}),
	};
}
