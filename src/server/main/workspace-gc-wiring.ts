/**
 * Workspace-GC boot wiring (warren-0a9a). Extracted from `main/index.ts`
 * to hold the boot entry under its 500-line budget — the same pattern as
 * `detector-wiring.ts` / `lifecycle-bus-wiring.ts`: `bootServer` passes
 * the boot-resolved seams in, this module owns the capability gate, the
 * worker construction, and the boot narration.
 *
 * The sweep is the fallback GC for workspaces stranded by a mid-reap
 * crash or an out-of-band force-kill. warren-e24d: it runs only when the
 * runtime advertises the `workspaceGc` capability — the local boot
 * backend hands down a `workspaceDestroyer` only then, so under K8s the
 * worker boots force-disabled and the sweep stays dark.
 */

import type {
	WorkspaceDestroyer,
	WorkspaceGcConfig,
	WorkspaceGcReposLike,
	WorkspaceGcWorkerHandle,
} from "../../runs/reap/gc.ts";
import { startWorkspaceGcWorker } from "../../runs/reap/gc.ts";
import type { Logger } from "../types.ts";
import { workspaceGcLoggerFromPino } from "./logging.ts";

export interface BootWorkspaceGcInput {
	/** Narrow repos seam — the sweep only lists terminal runs. */
	readonly repos: WorkspaceGcReposLike;
	/**
	 * Provider destroy seam from the local boot backend (warren-e24d).
	 * `undefined` means the runtime lacks the `workspaceGc` capability
	 * (K8s): the worker is constructed force-disabled below.
	 */
	readonly workspaceDestroyer: WorkspaceDestroyer | undefined;
	/** Operator config as resolved by `loadWorkspaceGcConfigFromEnv`. */
	readonly config: WorkspaceGcConfig;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/**
 * Boot the fallback workspace-GC sweep. When no `workspaceDestroyer`
 * came down from the runtime provider the operator config is overridden
 * to disabled, so the dark-under-K8s posture can't be re-armed by env.
 */
export function bootWorkspaceGc(input: BootWorkspaceGcInput): WorkspaceGcWorkerHandle {
	const resolvedConfig =
		input.workspaceDestroyer !== undefined ? input.config : { ...input.config, disabled: true };
	const worker = startWorkspaceGcWorker({
		repos: input.repos,
		destroyWorkspace:
			input.workspaceDestroyer ?? (async () => ({ status: "already-gone" as const })),
		config: resolvedConfig,
		logger: workspaceGcLoggerFromPino(input.logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	input.logger.info(
		{ ...resolvedConfig },
		resolvedConfig.disabled
			? "workspace GC disabled (WARREN_WORKSPACE_GC_DISABLED or runtime lacks workspaceGc capability)"
			: "workspace GC worker running",
	);
	return worker;
}
