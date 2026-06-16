import { useMemo, useState } from "react";
import {
	nextSortState,
	type SortDirection,
	type SortState,
} from "@/components/ui/sortable-table-head.tsx";
import { applySort, type Comparator } from "./use-client-sort.helpers.ts";

export {
	applySort,
	type Comparator,
	compareStrings,
} from "./use-client-sort.helpers.ts";

export interface UseClientSortResult<T, K extends string> {
	/** Rows ordered by the active column/direction (a fresh array). */
	sorted: T[];
	/** Current sort state — pass straight to `SortableTableHead`. */
	sort: SortState<K>;
	/** Header activation handler — pass straight to `SortableTableHead`. */
	onSort: (key: K) => void;
}

export interface UseClientSortOptions<K extends string> {
	/** Column to sort by on first render. */
	initialKey: K;
	/** Direction for the initial column (defaults to `"asc"`). */
	initialDirection?: SortDirection;
	/**
	 * Direction a column adopts the first time it becomes active. Timestamp
	 * columns typically want `"desc"`; omitted columns fall back to `"asc"`.
	 */
	defaultDirections?: Partial<Record<K, SortDirection>>;
}

/**
 * Client-side sorting for list tables built on `SortableTableHead`. Callers
 * supply an ascending comparator per sortable column; the hook owns the
 * `SortState`, toggles direction on re-click via `nextSortState`, and returns
 * a freshly sorted copy of `rows`. This is the canonical companion to the
 * shared header primitive for tables whose data already lives client-side
 * (Projects, PlanRuns, Agents, Workspace). Server-paginated tables (Runs)
 * keep driving sort through their query instead.
 */
export function useClientSort<T, K extends string>(
	rows: readonly T[],
	comparators: Record<K, Comparator<T>>,
	options: UseClientSortOptions<NoInfer<K>>,
): UseClientSortResult<T, K> {
	const [sort, setSort] = useState<SortState<K>>({
		key: options.initialKey,
		direction: options.initialDirection ?? "asc",
	});

	const onSort = (key: K): void => {
		setSort((current) => nextSortState(current, key, options.defaultDirections?.[key]));
	};

	const sorted = useMemo(() => applySort(rows, comparators, sort), [rows, sort, comparators]);

	return { sorted, sort, onSort };
}
