import { ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";
import {
	ariaSortFor,
	type SortDirection,
	type SortState,
} from "./sortable-table-head.helpers.ts";
import { TableHead } from "./table.tsx";

export {
	ariaSortFor,
	nextSortState,
	type SortDirection,
	type SortState,
} from "./sortable-table-head.helpers.ts";

export interface SortableTableHeadProps<K extends string>
	extends Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "onClick"> {
	/** Stable identifier for this column. */
	columnKey: K;
	/** Current table sort state. */
	sort: SortState<K>;
	/** Invoked with this column's key when the header is activated. */
	onSort: (key: K) => void;
	/** Cell text alignment; `right` also right-aligns the trigger. */
	align?: "left" | "right";
	children: React.ReactNode;
}

/**
 * Sortable column header primitive. Renders a `TableHead` carrying the correct
 * `aria-sort` state with an inner button that surfaces a direction chevron when
 * the column is active. This is the single canonical implementation that all
 * list tables (Runs, Workspace, Projects, PlanRuns, Agents) build on.
 */
export function SortableTableHead<K extends string>({
	columnKey,
	sort,
	onSort,
	align = "left",
	className,
	children,
	...rest
}: SortableTableHeadProps<K>) {
	const isActive = sort.key === columnKey;
	const Icon: typeof ChevronUp = (sort.direction satisfies SortDirection) === "asc"
		? ChevronUp
		: ChevronDown;
	return (
		<TableHead
			aria-sort={ariaSortFor(columnKey, sort)}
			className={cn("whitespace-nowrap", align === "right" && "text-right", className)}
			{...rest}
		>
			<button
				type="button"
				onClick={() => onSort(columnKey)}
				className={cn(
					"inline-flex items-center gap-1 transition-colors hover:text-(--color-fg)",
					align === "right" && "ml-auto",
					isActive && "text-(--color-fg)",
				)}
			>
				{children}
				{isActive ? <Icon className="h-3 w-3" aria-hidden="true" /> : null}
			</button>
		</TableHead>
	);
}
