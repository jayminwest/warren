import type * as React from "react";
import { cn } from "@/lib/utils.ts";

/**
 * PageHeader (warren-9474): every page opens the same way — a title, one
 * sentence of description, and right-aligned actions that wrap below the
 * title on a phone. `eyebrow` is a quiet line above the title for context
 * (a project name, a parent plan).
 */
export function PageHeader({
	title,
	description,
	eyebrow,
	actions,
	className,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	eyebrow?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
}) {
	return (
		<header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
			<div className="min-w-0 space-y-1">
				{eyebrow ? <div className="text-xs text-(--color-text-3)">{eyebrow}</div> : null}
				<h1 className="truncate text-xl font-semibold tracking-tight text-(--color-text)">
					{title}
				</h1>
				{description ? (
					<p className="max-w-2xl text-sm text-(--color-text-2)">{description}</p>
				) : null}
			</div>
			{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
		</header>
	);
}
