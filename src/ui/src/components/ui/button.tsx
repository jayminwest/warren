import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Button (warren-9474): primary is the one filled green action per view;
 * outline and ghost carry everything else. Sizes step 28/32/40px.
 */
const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-(--color-primary) text-(--color-primary-ink) shadow-sm hover:brightness-110 active:brightness-95",
				destructive:
					"bg-(--color-danger) text-(--color-danger-ink) shadow-sm hover:brightness-110 active:brightness-95",
				outline:
					"border border-(--color-border-strong) bg-(--color-surface) text-(--color-text) hover:bg-(--color-surface-hover) active:bg-(--color-surface-raised)",
				ghost:
					"text-(--color-text-2) hover:bg-(--color-surface-hover) hover:text-(--color-text) active:bg-(--color-surface-raised)",
				link: "px-0 text-(--color-primary) underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 px-3",
				sm: "h-7 px-2.5 text-xs",
				lg: "h-10 px-4",
				icon: "size-8",
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
			<Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
		);
	},
);
Button.displayName = "Button";

export { buttonVariants };
