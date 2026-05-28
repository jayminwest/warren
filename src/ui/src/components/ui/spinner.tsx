import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2b primitive (warren-57d7 / pl-55a3 step 3):
 *
 * Tiny wrapper around lucide-react's Loader2 with `animate-spin` baked
 * in. Audit found the same `<Loader|RefreshCw> animate-spin` idiom
 * duplicated across RefreshProjectsCTA, NewPlanRun, Agents, PlotDetail
 * (mx grep above) — phase 4+ replaces the bare `<p>Loading…</p>` sites
 * with this primitive plus a label, and phase 3 wires it into the
 * StatusIndicator registry's `running` state pulse.
 *
 * `size` matches the icon-size convention we use elsewhere (sm = h-3.5,
 * md = h-4, lg = h-5). `label` renders an sr-only span so the spinner
 * has an accessible name; default "Loading" is fine for the common
 * case and overridable for context (e.g. "Refreshing project").
 */
const SPINNER_SIZES = {
	sm: "h-3.5 w-3.5",
	md: "h-4 w-4",
	lg: "h-5 w-5",
} as const;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
	size?: keyof typeof SPINNER_SIZES;
	label?: string;
}

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
	({ className, size = "md", label = "Loading", ...props }, ref) => (
		<span
			ref={ref}
			role="status"
			aria-live="polite"
			className={cn("inline-flex items-center", className)}
			{...props}
		>
			<Loader2 aria-hidden="true" className={cn("animate-spin", SPINNER_SIZES[size])} />
			<span className="sr-only">{label}</span>
		</span>
	),
);
Spinner.displayName = "Spinner";
