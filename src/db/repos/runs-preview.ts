/**
 * Preview-environment write method for the `runs` table (R-19 /
 * docs/design/preview-environments.md), extracted from `RunsRepo` to keep
 * `runs.ts` under the file-size budget. Mirrors the `runs-pr.ts` /
 * `runs-queries.ts` precedent: a free function taking the
 * `DrizzleAdapter` first, with `RunsRepo` delegating so the call surface
 * is unchanged.
 */

import { eq } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { PreviewState, RunRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Legal per-run preview-environment advances (warren-66d2). Enumerated from
 * the live writers: the port allocator stamps `starting` (its own CAS),
 * launch/reap write `live`/`failed` through `attachPreview`, and teardown /
 * eviction flip `starting`/`live` → `torn-down` with a state-filtered CAS.
 *
 * `null` is the unset arm (project never opted in, or allocation failed
 * before `starting`) — hence `null → failed`. `torn-down` and `failed`
 * release the port; a retry re-enters at `starting`, which is why
 * `failed → starting` is legal while `torn-down → live` (warren-66d2) is not.
 */
const PREVIEW_ALLOWED_TRANSITIONS: Record<PreviewState | "unset", readonly PreviewState[]> = {
	unset: ["starting", "live", "failed"],
	starting: ["live", "failed", "torn-down"],
	live: ["failed", "torn-down"],
	failed: ["starting", "torn-down"],
	"torn-down": ["starting"],
};

/**
 * Guard one preview-state advance. A same-state write is an idempotent re-assert;
 * anything not in the table throws StateTransitionError (HTTP 409 via server/errors).
 */
export function assertPreviewTransition(from: PreviewState | null, to: PreviewState): void {
	if (from === to) return;
	if (!PREVIEW_ALLOWED_TRANSITIONS[from ?? "unset"].includes(to)) {
		throw new StateTransitionError(`invalid preview transition: ${from ?? "unset"} → ${to}`);
	}
}

export interface AttachPreviewInput {
	previewState?: PreviewState | null;
	previewPort?: number | null;
	previewStartedAt?: string | null;
	previewLastHitAt?: string | null;
	previewFailureMessage?: string | null;
}

/**
 * Persist per-run preview environment fields. Mirrors `attachStats`'s
 * partial-input semantics (mx-49272e): omitted fields preserve existing
 * values, explicit `null` clears. Throws ValidationError when called with
 * no fields, matching `attachBurrow` / `attachStats`. Used by reap's
 * `preview_launch` sub-step, the readiness probe, the host reverse proxy
 * (debounced `previewLastHitAt`), the eviction worker, and the manual
 * teardown route.
 */
export async function attachPreview(
	adapter: DrizzleAdapter,
	id: string,
	input: AttachPreviewInput,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const keys: (keyof AttachPreviewInput)[] = [
		"previewState",
		"previewPort",
		"previewStartedAt",
		"previewLastHitAt",
		"previewFailureMessage",
	];
	if (keys.every((k) => input[k] === undefined)) {
		throw new ValidationError("attachPreview requires at least one preview field");
	}
	const row = await adapter.pickOne<RunRow>(db.select().from(runs).where(eq(runs.id, id)));
	if (!row) throw new NotFoundError(`run not found: ${id}`);
	if (input.previewState !== undefined && input.previewState !== null) {
		assertPreviewTransition(row.previewState, input.previewState);
	}
	const patch: Partial<RunRow> = {};
	for (const k of keys) {
		if (input[k] !== undefined) {
			(patch as Record<string, unknown>)[k] = input[k];
		}
	}
	await adapter.runWrite(db.update(runs).set(patch).where(eq(runs.id, id)));
	return { ...row, ...patch };
}
