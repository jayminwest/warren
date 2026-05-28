import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 6 layout primitive (warren-e6b3 / pl-55a3 step 7):
 *
 * PageHeader — the canonical top-of-page banner. Audit found ~10
 * pages (Runs, Plots, Projects, PlanRuns, Agents, NewRun,
 * NewPlanRun, CostAnalytics, PlotDetail, PlotSummary) each rolling
 * their own `<header>` with `<h1 className="text-2xl font-semibold
 * tracking-tight">` + muted-foreground description + actions cluster.
 * This primitive consolidates that shape so all pages share spacing,
 * heading scale, and wrap behaviour.
 *
 * Slots:
 *   - `title`       — required heading. Renders inside `<h1>` unless
 *                     `as` overrides the tag.
 *   - `description` — optional muted secondary line.
 *   - `actions`     — optional right-aligned cluster (Buttons, Links).
 *   - `monoTitle`   — render the title in JetBrains Mono at xl scale
 *                     instead of the default 2xl semibold tracking.
 *                     Used by ID-keyed detail pages (PlanRunDetail,
 *                     ProjectDetail, RunDetail).
 *   - `as`          — override the heading tag (defaults to `h1`).
 */
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	monoTitle?: boolean;
	as?: "h1" | "h2";
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(
	(
		{ className, title, description, actions, monoTitle, as = "h1", children, ...props },
		ref,
	) => {
		const Heading = as;
		const headingClass = monoTitle
			? "font-mono text-xl font-semibold"
			: "text-2xl font-semibold tracking-tight";
		return (
			<header
				ref={ref}
				className={cn(
					"flex flex-wrap items-center justify-between gap-4",
					className,
				)}
				{...props}
			>
				<div className="min-w-0">
					<Heading className={headingClass}>{title}</Heading>
					{description ? (
						<p className="text-sm text-(--color-muted-foreground)">{description}</p>
					) : null}
					{children}
				</div>
				{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
			</header>
		);
	},
);
PageHeader.displayName = "PageHeader";
