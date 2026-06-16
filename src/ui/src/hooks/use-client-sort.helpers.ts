import type { SortState } from "@/components/ui/sortable-table-head.helpers.ts";

/** Comparator that orders two rows for a column in ascending direction. */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * Pure ordering step behind `useClientSort`: returns a fresh array sorted by
 * the active column's ascending comparator, flipped for `desc`. A `null` sort
 * key yields an unsorted copy. Lives in a react-free helper module so it can
 * be unit-tested without installing the UI dependency tree (mirrors the
 * `sortable-table-head.helpers.ts` split).
 */
export function applySort<T, K extends string>(
	rows: readonly T[],
	comparators: Record<K, Comparator<T>>,
	sort: SortState<K>,
): T[] {
	const copy = [...rows];
	if (sort.key === null) return copy;
	const compare = comparators[sort.key];
	const factor = sort.direction === "asc" ? 1 : -1;
	copy.sort((a, b) => factor * compare(a, b));
	return copy;
}

/** Locale-aware ascending string comparator with a stable nullish ordering. */
export function compareStrings(a: string | null | undefined, b: string | null | undefined): number {
	if (a == null && b == null) return 0;
	if (a == null) return -1;
	if (b == null) return 1;
	return a.localeCompare(b);
}
