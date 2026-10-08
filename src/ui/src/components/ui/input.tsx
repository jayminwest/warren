import * as React from "react";
import { cn } from "@/lib/utils.ts";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type = "text", ...props }, ref) => (
		<input
			ref={ref}
			type={type}
			className={cn(
				"flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs",
				"placeholder:text-(--color-muted-foreground)",
				"focus-visible:outline-none focus-visible:ring-(--color-ring) focus-visible:ring-2",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);
Input.displayName = "Input";
