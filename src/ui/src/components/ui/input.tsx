import * as React from "react";
import { cn } from "@/lib/utils.ts";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type = "text", ...props }, ref) => (
		<input
			ref={ref}
			type={type}
			className={cn(
				"flex h-9 w-full rounded-md border bg-(--color-surface) px-3 py-1 text-sm shadow-xs",
				"placeholder:text-(--color-text-2)",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-strong)",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);
Input.displayName = "Input";
