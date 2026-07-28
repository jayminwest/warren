/**
 * Feature-neutral artifact deltas `finalize` extracts from the live workspace
 * and returns for the domain to apply to its project clone.
 *
 * ## Why opaquely keyed (warren-df3e)
 *
 * The finalize seam used to enumerate warren's data-plane features directly —
 * a `mulch | seeds | plans` union on the intent and a
 * `{ mulch?, seeds?, plans? }` record on the result. That made the runtime
 * contract grow a slot every time a feature landed. It now speaks a single,
 * opaque {@link ArtifactDelta} keyed by a provider-chosen string
 * (`Record<string, ArtifactDelta>`): providers still know which merges they run
 * (mulch expertise LWW, the seeds/plans mirror) and pick the key, but the
 * CONTRACT names no feature. The domain reads a delta back by the same opaque
 * key; the seam itself is feature-neutral.
 *
 * Extracted from `contract.ts` (warren-e9e1) to keep that file under its frozen
 * size budget; re-exported from `contract.ts` so importers are unaffected.
 *
 * Contract guarantees for every delta:
 *   - **JSON-serializable** — round-trips through `JSON.parse(JSON.stringify(x))`
 *     unchanged. These are the wire format the K8s in-pod finalize (plan step
 *     20) emits over its callback, so no `Map`/`Set`/`Date`/`undefined` slots.
 *   - **`version`-tagged** so the wire format can evolve unambiguously.
 *   - **Apply-complete without filesystem access** — each `files[]` entry carries
 *     the full post-merge body, so the domain applies by overwriting the target
 *     file; it never has to read the (by-then-destroyed) workspace.
 */

/** One post-merge file the domain overwrites in the project clone. */
export interface ArtifactDeltaFile {
	/** clone-relative (posix) target path, e.g. `.mulch/expertise/build.jsonl` */
	path: string;
	/** full merged body — the domain writes it verbatim */
	mergedBody: string;
}

/**
 * One artifact set's finalize delta — feature-neutral. `files` are the
 * clone-relative bodies to overwrite (empty when the merge was a no-op);
 * `counts` are provider-defined, opaquely-named tallies the domain records and
 * re-emits (e.g. mulch's `{updated,skipped,appended}`, seeds' `{closed,created}`,
 * plans' `{appended}`). The finalize seam does NOT name which artifact produced
 * them — the caller keys the enclosing `Record<string, ArtifactDelta>`.
 */
export interface ArtifactDelta {
	version: 1;
	/**
	 * Post-merge files to overwrite in the project clone. Each carries the full
	 * body + clone-relative path so the domain applies without reading the
	 * workspace. Empty when the merge produced nothing (a no-op mirror).
	 */
	files: ArtifactDeltaFile[];
	/**
	 * Opaque, provider-defined counts. Keys are the merge function's own tally
	 * names; absent keys read as `0` at the domain. Feature-neutral: the seam
	 * carries the numbers, not the meaning.
	 */
	counts: Record<string, number>;
}
