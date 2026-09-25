import type * as React from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Stat strip (warren-9474): a row of headline figures in one bordered
 * surface. Each cell is a sentence-case label, a large sans figure with
 * tabular numerals, and one quiet detail line. The hairlines come from a
 * 1px grid gap over the border colour, so they hold in the two-column
 * phone grid and the single desktop row alike.
 *
 * Shared by Operations and Telemetry; a candidate for components/ui.
 */

export interface StatCell {
	readonly key: string;
	readonly label: React.ReactNode;
	/** The figure; `null` while loading renders a skeleton in its place. */
	readonly value: React.ReactNode | null;
	readonly unit?: React.ReactNode;
	readonly detail?: React.ReactNode;
	readonly title?: string;
	/** Extra classes for the figure (a tone colour, a quiet state). */
	readonly valueClassName?: string;
}

const COLS: Record<number, string> = {
	1: "md:grid-cols-1",
	2: "md:grid-cols-2",
	3: "md:grid-cols-3",
	4: "md:grid-cols-4",
};

export function StatStrip({
	cells,
	className,
}: {
	cells: readonly StatCell[];
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 gap-px overflow-hidden rounded-md border border-(--color-border) bg-(--color-border)",
				COLS[cells.length] ?? "md:grid-cols-4",
				cells.length % 2 === 1 && "[&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1",
				className,
			)}
		>
			{cells.map((cell) => (
				<div
					key={cell.key}
					title={cell.title}
					className="flex min-w-0 flex-col gap-1 bg-(--color-surface) px-4 py-3 md:py-4"
				>
					<span className="truncate text-xs text-(--color-text-2)">{cell.label}</span>
					<span className="flex min-w-0 items-baseline gap-1.5">
						{cell.value === null ? (
							<Skeleton className="my-1.5 h-6 w-16" />
						) : (
							<span
								className={cn(
									"truncate text-xl font-semibold tracking-tight text-(--color-text) tabular-nums md:text-2xl",
									cell.valueClassName,
								)}
							>
								{cell.value}
							</span>
						)}
						{cell.unit && cell.value !== null ? (
							<span className="shrink-0 text-sm text-(--color-text-3)">{cell.unit}</span>
						) : null}
					</span>
					{cell.detail ? (
						<span className="line-clamp-2 text-xs text-(--color-text-3)">{cell.detail}</span>
					) : null}
				</div>
			))}
		</div>
	);
}
