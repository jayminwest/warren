import type * as React from "react";
import { cn } from "@/lib/utils.ts";

/** Keyboard key cap (warren-9474). */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-(--color-border-strong) bg-(--color-surface-raised) px-1 font-sans text-2xs font-medium text-(--color-text-2)",
				className,
			)}
		>
			{children}
		</kbd>
	);
}
