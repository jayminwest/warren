import * as React from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Card (warren-9474): the one panel surface. A hairline border on the
 * surface colour, `rounded-md`, and a header row that carries a title, an
 * optional quiet meta line, and right-aligned actions. Cards size to their
 * content — never stretch a card to fill a grid row (warren-dac1).
 */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => (
		<div
			ref={ref}
			className={cn(
				"min-w-0 self-start overflow-hidden rounded-md border border-(--color-border) bg-(--color-surface)",
				className,
			)}
			{...props}
		/>
	),
);
Card.displayName = "Card";

export function CardHeader({
	title,
	meta,
	actions,
	className,
}: {
	title: React.ReactNode;
	meta?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-11 items-center justify-between gap-3 border-b border-(--color-border) px-4 py-2.5",
				className,
			)}
		>
			<div className="flex min-w-0 items-baseline gap-2">
				<h2 className="truncate text-sm font-medium text-(--color-text)">{title}</h2>
				{meta ? <span className="truncate text-xs text-(--color-text-3)">{meta}</span> : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}

export const CardBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
	({ className, ...props }, ref) => <div ref={ref} className={cn("p-4", className)} {...props} />,
);
CardBody.displayName = "CardBody";

export function CardFooter({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 border-t border-(--color-border) px-4 py-2.5 text-xs text-(--color-text-3)",
				className,
			)}
		>
			{children}
		</div>
	);
}
