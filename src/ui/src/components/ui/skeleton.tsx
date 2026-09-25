import { cn } from "@/lib/utils.ts";

/** Shimmer placeholder (warren-9474). Size it with width/height classes. */
export function Skeleton({ className }: { className?: string }) {
	return <span aria-hidden className={cn("skeleton block h-3.5 rounded-sm", className)} />;
}

/**
 * Loading rows for a list or table body: `rows` lines with a status-dot
 * stub and staggered widths, so a loading list has the shape of the list.
 */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
	const widths = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3", "w-1/4"];
	return (
		<div
			role="status"
			aria-label="Loading"
			className={cn("divide-y divide-(--color-border)", className)}
		>
			{Array.from({ length: rows }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder
				<div key={i} className="flex h-11 items-center gap-3 px-4">
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className={widths[i % widths.length]} />
					<Skeleton className="ml-auto w-12" />
				</div>
			))}
		</div>
	);
}
