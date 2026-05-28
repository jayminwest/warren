import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2a primitives (warren-6e69 / pl-55a3 step 2):
 *
 * Buttons now have a real pressed feedback step — `active:opacity-80`
 * for filled variants, `active:opacity-90` for the chrome variants —
 * stacked on top of the existing hover state. The shared
 * `transition-colors` (with Tailwind's default 150ms) keeps the hover
 * and active transitions in lockstep without spending bundle bytes on
 * extra transition-property utilities. The `link` variant also picks
 * up the pressed feedback so keyboard/touch users get the same
 * affordance as buttons.
 */
const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default:
					"bg-(--color-primary) text-(--color-primary-foreground) hover:opacity-90 active:opacity-80",
				destructive:
					"bg-(--color-destructive) text-(--color-destructive-foreground) hover:opacity-90 active:opacity-80",
				outline:
					"border bg-(--color-card) text-(--color-fg) hover:bg-(--color-accent) hover:text-(--color-fg) active:opacity-80",
				ghost: "text-(--color-fg) hover:bg-(--color-accent) active:opacity-80",
				link: "text-(--color-fg) underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3 text-xs",
				lg: "h-10 rounded-md px-6",
				icon: "h-9 w-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				ref={ref}
				className={cn(buttonVariants({ variant, size, className }))}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { buttonVariants };
