import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2b primitive (warren-57d7 / pl-55a3 step 3):
 *
 * Generic skeleton block: `animate-pulse` over the existing
 * --color-muted token so the placeholder shares the gray ramp with
 * Input/Card. No bespoke shapes — callers compose width/height/rounded
 * via the `className` prop (e.g. `<Skeleton className="h-4 w-32" />`
 * for a single text row). Phase 4 / 7 will replace the ~10 ad-hoc
 * `<p>Loading…</p>` sites with skeleton compositions on real
 * surfaces (Run list rows, plot cards, etc).
 *
 * Animation is gated behind `motion-safe:` so users with
 * prefers-reduced-motion see a static placeholder rather than a pulse.
 */
export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
	({ className, ...props }, ref) => (
		<div
			ref={ref}
			aria-hidden="true"
			className={cn(
				"motion-safe:animate-pulse rounded-md bg-(--color-muted)",
				className,
			)}
			{...props}
		/>
	),
);
Skeleton.displayName = "Skeleton";
