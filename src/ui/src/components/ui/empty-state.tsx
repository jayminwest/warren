import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 4 shared-state primitive (warren-36f0 / pl-55a3 step 5):
 *
 * EmptyState — a centered "nothing here yet" placeholder for list and
 * detail surfaces. Audit found ~12 ad-hoc empty branches across pages/
 * (Plots.tsx had its own local EmptyState, ProjectDetail.tsx had
 * EmptyHint, Runs/Projects/PlanRuns/PlotDetail used bare `<p>`
 * placeholders) — this primitive consolidates them so all empty
 * surfaces share the same vertical rhythm, icon size, and muted color
 * token.
 *
 * Slots:
 *   - `icon` — optional lucide-react icon component (constructor),
 *     rendered at 6rem in muted color above the title. Pass the
 *     component itself, not an element, e.g. `icon={Inbox}`.
 *   - `title` — short headline, required.
 *   - `description` — optional secondary copy.
 *   - `action`  — optional element rendered below (typically a
 *     `<Button>` or `<RefreshProjectsCTA />`).
 *   - `compact` — denser vertical padding for table-row contexts.
 */
export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	icon?: LucideIcon;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
	compact?: boolean;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
	(
		{ className, icon: Icon, title, description, action, compact, children, ...props },
		ref,
	) => (
		<div
			ref={ref}
			className={cn(
				"flex flex-col items-center justify-center text-center gap-2",
				compact ? "py-6" : "py-12",
				className,
			)}
			{...props}
		>
			{Icon ? (
				<Icon
					aria-hidden="true"
					className="h-8 w-8 text-(--color-muted-foreground) opacity-70"
				/>
			) : null}
			<div className="text-sm font-medium text-(--color-fg)">{title}</div>
			{description ? (
				<div className="text-sm text-(--color-muted-foreground) max-w-prose">
					{description}
				</div>
			) : null}
			{children}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	),
);
EmptyState.displayName = "EmptyState";
