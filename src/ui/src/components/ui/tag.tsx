import type * as React from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Tag (warren-9474): a neutral, quiet label — a runtime, a trigger, a
 * count of commits. Status never uses a Tag; it uses StatusBadge, whose
 * colour carries the meaning.
 */
export function Tag({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center gap-1 rounded-xs border border-(--color-border) bg-(--color-surface-raised) px-1.5 text-xs whitespace-nowrap text-(--color-text-2)",
				className,
			)}
			{...props}
		/>
	);
}
