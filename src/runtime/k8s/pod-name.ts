/**
 * Run-pod NAME derivation + label-VALUE sanitization (warren-2e2e extraction
 * from `pod-spec.ts` for the file-size ratchet; `pod-spec.ts` re-exports this
 * surface so it stays the single import point for the pod shape).
 */

/**
 * Derive the pod name for a run. warren run ids look like `run_01tdf3a0wg5e`;
 * the underscore is legal in a K8s label VALUE but NOT in a resource NAME
 * (DNS-1123: lowercase alphanumerics + `-`, ≤253). We lowercase, replace every
 * illegal char with `-`, collapse runs of `-`, and trim leading/trailing `-`.
 * The exact `runId` still travels verbatim on the `warren.io/run-id` label so
 * the pod-watcher can select it (labels permit `_`).
 */
export function podNameForRun(runId: string): string {
	const sanitized = runId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const name = `run-${sanitized}`;
	return name.length > 253 ? name.slice(0, 253).replace(/-+$/g, "") : name;
}

/**
 * Coerce a value into a legal K8s label VALUE: ≤63 chars of `[A-Za-z0-9._-]`,
 * beginning and ending with an alphanumeric. Illegal chars collapse to `-`;
 * blank/all-illegal input ⇒ `undefined` (no label stamped). Warren project ids
 * (`proj_<ulid>`) are already legal, so this is a defensive normalizer, not a
 * transform of the common case.
 */
export function sanitizeLabelValue(raw: string | undefined): string | undefined {
	if (raw === undefined || raw === "") return undefined;
	const collapsed = raw
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 63);
	const trimmed = collapsed.replace(/^[._-]+|[._-]+$/g, "");
	return trimmed === "" ? undefined : trimmed;
}
