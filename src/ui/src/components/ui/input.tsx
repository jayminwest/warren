import * as React from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Form control surface (warren-9474), shared by Input, Select and
 * Textarea: sunken on the page background with a strong hairline, a
 * primary focus ring, and the 44px/16px phone treatment so iOS never
 * zooms on focus.
 */
export const controlSurface = cn(
	"w-full min-w-0 rounded-sm border border-(--color-border-strong) bg-(--color-bg) px-2.5 text-(--color-text)",
	"placeholder:text-(--color-text-3) transition-colors hover:border-(--color-text-3)",
	"focus-visible:border-(--color-primary) focus-visible:ring-2 focus-visible:ring-(--color-primary)/25 focus-visible:outline-none",
	"disabled:cursor-not-allowed disabled:opacity-50",
);

export const controlHeight = "h-11 text-input sm:h-8 sm:text-sm";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type = "text", ...props }, ref) => (
		<input
			ref={ref}
			type={type}
			className={cn(controlSurface, controlHeight, className)}
			{...props}
		/>
	),
);
Input.displayName = "Input";
