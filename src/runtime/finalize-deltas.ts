/**
 * Artifact-set deltas `finalize` extracts from the live workspace and returns
 * for the domain to apply to its project clone. PINNED (pl-829f step 12 /
 * warren-371a) by SERIALIZING what today's in-process reap merge functions
 * (`src/runs/reap/{mulch,seeds,plot-merge}.ts`) actually produce — grounded in
 * their real return values, not a speculative shape.
 *
 * Extracted from `contract.ts` (warren-e9e1) to keep that file under its frozen
 * size budget; re-exported from `contract.ts` so importers are unaffected.
 *
 * Contract guarantees for every delta:
 *   - **JSON-serializable** — round-trips through `JSON.parse(JSON.stringify(x))`
 *     unchanged. These are the wire format the K8s in-pod finalize (plan step
 *     20) emits over its callback, so no `Map`/`Set`/`Date`/`undefined` slots.
 *   - **`version`-tagged** so the wire format can evolve unambiguously.
 *   - **Apply-complete without filesystem access** — mulch / seeds / plans each
 *     carry the full post-merge JSONL body, so the domain applies by overwriting
 *     the target file; it never has to read the (by-then-destroyed) workspace.
 *     The counts mirror each merge function's own return value.
 */

/** One domain's post-merge mulch expertise file. */
export interface MulchDeltaFile {
	/** expertise filename minus `.jsonl` (e.g. `build`) */
	domain: string;
	/** clone-relative (posix) target path: `.mulch/expertise/<domain>.jsonl` */
	path: string;
	/** full merged JSONL body — the domain writes it verbatim */
	mergedBody: string;
}

/**
 * mulch expertise LWW-merge result — mirrors `MulchMergeResult`
 * (`{updated,skipped,appended}`) plus the per-file merged bodies
 * `mergeMulchFile` produces. "real effort" per `data-plane-trajectory.md`:
 * mulch is the memory layer, so its delta is complete.
 */
export interface MulchDelta {
	version: 1;
	/** records replaced because the incoming `recorded_at` was newer */
	updated: number;
	/** records dropped because the incoming was older-or-equal */
	skipped: number;
	/** brand-new records appended */
	appended: number;
	/** one entry per workspace expertise file, carrying its merged body */
	files: MulchDeltaFile[];
}

/**
 * seeds issue-tracker close/create mirror — mirrors `MirrorSeedsResult`
 * (`{closed,created}`) plus the merged `issues.jsonl`. Connector-shaped per
 * `data-plane-trajectory.md` (seeds is a swappable tracker), so this is done
 * properly: the full merged body travels for a filesystem-free apply.
 */
export interface SeedsDelta {
	version: 1;
	/** rows transitioned to `closed` (added-as-closed or status-updated) */
	closed: number;
	/** brand-new rows (e.g. planner-created) added to the clone */
	created: number;
	/** clone-relative (posix) target path: `.seeds/issues.jsonl` */
	path: string;
	/**
	 * full merged issues.jsonl, or `null` when the mirror was a no-op (the
	 * workspace had no `.seeds/issues.jsonl`, or it produced no delta).
	 */
	mergedBody: string | null;
}

/**
 * seeds plan mirror — append-only (plans are immutable once submitted).
 * Mirrors `mirrorPlans`'s `added` count plus the merged `plans.jsonl`.
 */
export interface PlansDelta {
	version: 1;
	/** plan rows appended to the clone */
	appended: number;
	/** clone-relative (posix) target path: `.seeds/plans.jsonl` */
	path: string;
	/** full merged plans.jsonl, or `null` when nothing was appended */
	mergedBody: string | null;
}
