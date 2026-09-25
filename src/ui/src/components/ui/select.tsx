import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";
import { controlHeight, controlSurface } from "./input.tsx";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
	/** Classes for the wrapper (width, flex sizing). */
	wrapperClassName?: string;
};

/**
 * Native select styled as a console control (warren-9474). Native keeps
 * the phone picker and keyboard behaviour; the chevron is drawn over it.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
	({ className, wrapperClassName, children, ...props }, ref) => (
		<span className={cn("relative inline-flex min-w-0", wrapperClassName)}>
			<select
				ref={ref}
				className={cn(controlSurface, controlHeight, "appearance-none pr-7", className)}
				{...props}
			>
				{children}
			</select>
			<ChevronDown
				aria-hidden
				className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-(--color-text-3)"
			/>
		</span>
	),
);
Select.displayName = "Select";
