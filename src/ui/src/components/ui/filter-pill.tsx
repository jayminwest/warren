import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 6 layout primitive (warren-e6b3 / pl-55a3 step 7):
 *
 * FilterPill — the canonical "rounded chip toggle" surface. Extracted
 * from Runs.tsx's inline FilterPill (the original implementation) so
 * Plots.tsx's `aria-pressed` toggles and any future filter strip can
 * share the active / hover / focus treatment.
 *
 * Active pills paint with the primary token; inactive pills sit on
 * card with a subtle hover. `pressed` is mirrored to `aria-pressed`
 * for screen readers — the component is a proper toggle button, not
 * a styled link.
 *
 * `FilterPillGroup` is a thin layout wrapper that gives the strip
 * `flex flex-wrap gap-2` so pages don't keep retyping the same
 * container.
 */
export interface FilterPillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	/** Whether the pill is in its toggled-on state. Mirrored to `aria-pressed`. */
	active: boolean;
	/** Convenience: render the label as the button's only child. */
	label?: React.ReactNode;
}

export const FilterPill = React.forwardRef<HTMLButtonElement, FilterPillProps>(
	({ className, active, label, children, type = "button", ...props }, ref) => (
		<button
			ref={ref}
			type={type}
			aria-pressed={active}
			className={cn(
				"rounded-full border px-3 py-1 text-xs transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)",
				active
					? "bg-(--color-primary) text-(--color-primary-foreground)"
					: "bg-(--color-card) hover:bg-(--color-accent)",
				className,
			)}
			{...props}
		>
			{label ?? children}
		</button>
	),
);
FilterPill.displayName = "FilterPill";

export const FilterPillGroup = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		role="group"
		className={cn("flex flex-wrap gap-2", className)}
		{...props}
	/>
));
FilterPillGroup.displayName = "FilterPillGroup";
