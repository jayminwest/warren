import * as React from "react";
import { cn } from "@/lib/utils.ts";
import { controlSurface } from "./input.tsx";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line control on the shared control surface (warren-9474). */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, ...props }, ref) => (
		<textarea
			ref={ref}
			className={cn(controlSurface, "min-h-20 py-2 text-input sm:text-sm", className)}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";
