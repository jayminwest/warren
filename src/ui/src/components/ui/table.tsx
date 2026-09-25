/**
 * Console table (warren-9474): 32px sentence-case header on the thead
 * tint, 44px rows with hairline dividers, tabular numerals, horizontal
 * scroll inside its own container on a phone. Every data table uses it.
 */
import * as React from "react";
import { cn } from "@/lib/utils.ts";

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
	({ className, ...props }, ref) => (
		<div className="relative w-full overflow-x-auto">
			<table
				ref={ref}
				className={cn("w-full caption-bottom text-sm tabular-nums", className)}
				{...props}
			/>
		</div>
	),
);
Table.displayName = "Table";

export const TableHeader = React.forwardRef<
	HTMLTableSectionElement,
	React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
	<thead
		ref={ref}
		className={cn("bg-(--color-thead) [&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
		{...props}
	/>
));
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<
	HTMLTableSectionElement,
	React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
	<tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

export const TableRow = React.forwardRef<
	HTMLTableRowElement,
	React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
	<tr
		ref={ref}
		className={cn(
			"border-b border-(--color-border) transition-colors hover:bg-(--color-surface-hover) data-[selected=true]:bg-(--color-surface-hover)",
			className,
		)}
		{...props}
	/>
));
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<
	HTMLTableCellElement,
	React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
	<th
		ref={ref}
		className={cn(
			"h-8 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-(--color-text-3) first:pl-4 last:pr-4",
			className,
		)}
		{...props}
	/>
));
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<
	HTMLTableCellElement,
	React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
	<td
		ref={ref}
		className={cn("h-11 px-3 py-2 align-middle first:pl-4 last:pr-4", className)}
		{...props}
	/>
));
TableCell.displayName = "TableCell";
