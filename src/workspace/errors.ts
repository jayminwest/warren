/**
 * Errors specific to workspace materialization (the K8s init-container path).
 *
 * Extracted from burrow's `core/errors.ts` — its `WorkspaceMaterializationError`
 * folded into warren's central `WarrenError` hierarchy (see
 * `docs/design/k8s-migration-plan.md` §5.A). Following the warren per-module
 * idiom (cf. `src/burrow-client/errors.ts`), the workspace cluster owns its own
 * error class extending the shared base so callers can catch by class or switch
 * on `code`, and the CLI/HTTP renderers format it uniformly.
 */

import { WarrenError } from "../core/errors.ts";

export class WorkspaceMaterializationError extends WarrenError {
	readonly code = "workspace_materialization_failed";
}

/**
 * Thrown when environment/secret resolution fails — a required key can't be
 * resolved, or an `op://` reference lookup fails (see `env.ts` / `op.ts`).
 *
 * Extracted from burrow's `SecretResolutionError` (same `secret_resolution_failed`
 * code) and re-homed under the shared `WarrenError` base so the workspace cluster
 * owns its own errors without dragging in burrow's error module.
 */
export class SecretResolutionError extends WarrenError {
	readonly code = "secret_resolution_failed";
}
