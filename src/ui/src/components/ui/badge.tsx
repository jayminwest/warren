import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva(
	"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
	{
		variants: {
			variant: {
				default: "border-transparent bg-(--color-primary) text-(--color-primary-foreground)",
				secondary: "border-transparent bg-(--color-muted) text-(--color-fg)",
				destructive:
					"border-transparent bg-(--color-destructive) text-(--color-destructive-foreground)",
				outline: "text-(--color-fg)",
				running: "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-300",
				queued: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
				paused: "border-transparent bg-yellow-500/20 text-yellow-800 dark:text-yellow-200",

				succeeded: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
				failed: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-300",
				cancelled: "border-transparent bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
				drafting: "border-transparent bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
				ready: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
				active: "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-300",
				done: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
				archived: "border-transparent bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
