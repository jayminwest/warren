import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2b primitive (warren-57d7 / pl-55a3 step 3):
 *
 * Thin shadcn-style wrapper over @radix-ui/react-tooltip. Radix is the
 * only dependency added in Phase 2b: hover + focus + escape + portal +
 * polite-collision behavior aren't worth re-implementing, and the
 * design system already commits to Radix elsewhere (Dialog, Label).
 *
 * Default `delayDuration={150}` matches our transition cadence so
 * tooltips feel attached to the cursor rather than late. `Provider`
 * should live near the app root in a later phase; for now the
 * primitive re-exports it so callers can colocate one provider per
 * surface without us forcing a global wiring change in Phase 2b.
 *
 * Phase 3 (StatusIndicator) and Phase 4 (cost cell, ghost-run
 * indicators) are the first call sites — see PlanRuns.tsx priced-count
 * tooltip (mx-3615ff), RunDetail cost badge tooltip (mx-9d987a),
 * classifyAgentSource project-id tooltip (mx-620358).
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
	<TooltipPrimitive.Content
		ref={ref}
		sideOffset={sideOffset}
		className={cn(
			"z-50 max-w-xs rounded-md border bg-(--color-card) px-2.5 py-1.5 text-xs text-(--color-fg) shadow-md",
			"data-[state=delayed-open]:animate-in data-[state=closed]:animate-out",
			className,
		)}
		{...props}
	>
		{children}
	</TooltipPrimitive.Content>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
