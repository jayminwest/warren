/**
 * `LocalProvider.workspaceInfo` body (warren-e9e1) — the burrow-backed answer to
 * reap's "where is this run's workspace, and what branch does it push?" question.
 *
 * This is a FAITHFUL lift of the inline `burrows.get` resolution `reapRun` used
 * to do (`src/runs/reap/run.ts`, pre-warren-e9e1): the SAME `GET /burrows/:id`
 * over the SAME transport mapping, returning the SAME `workspacePath` (raw) +
 * `branch` (non-empty-string-or-null) it derived. Behavior is byte-identical —
 * a burrow error still throws so the domain records `workspace_lookup` and skips
 * the pipeline, and a live burrow still yields the host worktree path + branch.
 */

import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { RunHandle, WorkspaceInfo } from "../contract.ts";

/**
 * Resolve the live burrow's workspace path + branch. `handle.sandboxId` is the
 * burrowId. Mirrors reap's historical shape: `workspacePath` is passed through
 * as burrow reports it, and `branch` is coerced to `null` when burrow exposed no
 * (or an empty) branch — the same normalization reap did before the finalize
 * intent was built.
 */
export async function localWorkspaceInfo(
	client: BurrowClient,
	handle: RunHandle,
): Promise<WorkspaceInfo> {
	const burrow = await withTransportMapping(client.config, () =>
		client.http.burrows.get(handle.sandboxId),
	);
	const branch = typeof burrow.branch === "string" && burrow.branch !== "" ? burrow.branch : null;
	return { workspacePath: burrow.workspacePath, branch };
}
