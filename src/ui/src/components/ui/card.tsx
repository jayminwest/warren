import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2a primitives (warren-6e69 / pl-55a3 step 2):
 *
 * Card grows elevation variants without changing the default look.
 * `default` keeps `shadow-xs` so existing call sites render
 * identically; `elevated` raises to `shadow-md` for content meant to
 * read above the page.
 *
 * Phase 6 (warren-e6b3 / pl-55a3 step 7) added:
 *   - `flat` — no shadow, smaller `rounded-md` corner, used by the
 *     ad-hoc `rounded-md border bg-(--color-card)` panels the sweep
 *     promoted onto Card. Pairs with a translucent muted fill via
 *     a className override on call sites that need it.
 *
 * Phase 7 (warren-2221) will add an `interactive` variant (hover
 * border + shadow lift) once the PlotDetail decomposition surfaces
 * actual clickable-row sites — adding it now would just pay the
 * bundle-size cost for utilities no consumer references yet.
 */
const cardVariants = cva(
	"border bg-(--color-card) text-(--color-fg)",
	{
		variants: {
			variant: {
				default: "rounded-lg shadow-xs",
				elevated: "rounded-lg shadow-md",
				flat: "rounded-md",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface CardProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
	({ className, variant, ...props }, ref) => (
		<div ref={ref} className={cn(cardVariants({ variant, className }))} {...props} />
	),
);
Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => (
		<div ref={ref} className={cn("flex flex-col space-y-1.5 p-5", className)} {...props} />
	),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => (
		<div
			ref={ref}
			className={cn("text-base font-semibold leading-none tracking-tight", className)}
			{...props}
		/>
	),
);
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("text-sm text-(--color-muted-foreground)", className)}
		{...props}
	/>
));
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => (
		<div ref={ref} className={cn("p-5 pt-0", className)} {...props} />
	),
);
CardContent.displayName = "CardContent";

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => (
		<div ref={ref} className={cn("flex items-center p-5 pt-0", className)} {...props} />
	),
);
CardFooter.displayName = "CardFooter";

export { cardVariants };
