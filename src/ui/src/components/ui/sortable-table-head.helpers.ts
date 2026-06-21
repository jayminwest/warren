export type SortDirection = "asc" | "desc";

/**
 * Canonical sort state shared by every sortable list table: the currently
 * active column key (or `null` when nothing is sorted) plus its direction.
 */
export interface SortState<K extends string> {
	key: K | null;
	direction: SortDirection;
}

/** ARIA `aria-sort` token values. */
export type AriaSort = "none" | "ascending" | "descending";

/**
 * Pure ARIA mapping for a column header given the active sort state. Exposed
 * separately so it can be unit-tested without a DOM and reused by tables that
 * render their own `<th>` markup during migration.
 */
export function ariaSortFor<K extends string>(columnKey: K, state: SortState<K>): AriaSort {
	if (state.key !== columnKey) return "none";
	return state.direction === "asc" ? "ascending" : "descending";
}

/**
 * Compute the next sort state when a header is activated. Toggling the active
 * column flips direction; switching columns adopts `defaultDirection` (defaults
 * to `"asc"`, matching the existing table conventions).
 */
export function nextSortState<K extends string>(
	state: SortState<K>,
	columnKey: K,
	defaultDirection: SortDirection = "asc",
): SortState<K> {
	if (state.key === columnKey) {
		return { key: columnKey, direction: state.direction === "asc" ? "desc" : "asc" };
	}
	return { key: columnKey, direction: defaultDirection };
}
