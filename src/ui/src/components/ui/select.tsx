import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2b primitive (warren-57d7 / pl-55a3 step 3):
 *
 * `Select` is a styled wrapper around the native <select>. It mirrors
 * the Input primitive's shape (h-9, rounded-md, border, bg-(--color-card),
 * focus ring) so a Select sitting next to an Input on a form row reads
 * as the same control family. Phase 3+ will migrate the 6+ ad-hoc
 * `<select className="h-8 ... rounded-md border bg-(--color-card)">`
 * sites in src/ui/src/pages/ onto this primitive (audit acceptance
 * criterion 7).
 *
 * Native select keeps the keyboard/touch behavior we want for free —
 * platform popup, escape-to-cancel, type-ahead — without paying the
 * Radix popper bundle cost. Trade-off: option styling is OS-defined.
 * If a future surface needs custom option rendering (e.g. icons in
 * options), the upgrade path is @radix-ui/react-select with the same
 * exported API name.
 *
 * A trailing ChevronDown is rendered via a relative wrapper because
 * `appearance-none` strips the native caret. The wrapper is opt-in via
 * the `Select` component itself; callers needing the bare <select>
 * (e.g. inside an existing pre-styled row) can import `selectClassName`
 * and skip the chrome.
 */
export const selectClassName = cn(
	"flex h-9 w-full appearance-none rounded-md border bg-(--color-card) pl-3 pr-8 py-1 text-sm shadow-xs",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)",
	"disabled:cursor-not-allowed disabled:opacity-50",
);

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
	({ className, children, ...props }, ref) => (
		<div className="relative inline-flex w-full">
			<select ref={ref} className={cn(selectClassName, className)} {...props}>
				{children}
			</select>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-(--color-muted-foreground)"
			/>
		</div>
	),
);
Select.displayName = "Select";
