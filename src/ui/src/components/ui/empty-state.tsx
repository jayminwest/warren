import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 4 shared-state primitive (warren-36f0 / pl-55a3 step 5):
 *
 * EmptyState — a centered "nothing here yet" placeholder for list and
 * detail surfaces. Consolidates the former ad-hoc empty branches across
 * pages so all empty surfaces share the same vertical rhythm, icon size,
 * and muted color token.
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
	({ className, icon: Icon, title, description, action, compact, children, ...props }, ref) => (
		<div
			ref={ref}
			className={cn(
				"animate-fade-in flex flex-col items-center justify-center gap-1.5 px-6 text-center",
				compact ? "py-8" : "py-14",
				className,
			)}
			{...props}
		>
			{Icon ? (
				<span className="mb-2 inline-flex size-9 items-center justify-center rounded-md border border-(--color-border) bg-(--color-surface-raised)">
					<Icon aria-hidden="true" className="size-4 text-(--color-text-3)" />
				</span>
			) : null}
			<div className="text-base font-medium text-(--color-text)">{title}</div>
			{description ? (
				<div className="max-w-sm text-sm text-(--color-text-3)">{description}</div>
			) : null}
			{children}
			{action ? <div className="mt-3">{action}</div> : null}
		</div>
	),
);
EmptyState.displayName = "EmptyState";
