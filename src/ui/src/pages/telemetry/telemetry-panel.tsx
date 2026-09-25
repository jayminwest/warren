import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardBody, CardHeader } from "@/components/ui/card.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { formatError } from "@/lib/format-error.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The Telemetry panel (warren-7197, migrated in warren-9474): a Card with
 * a sentence-case title, a quiet meta line, and a padded body. `flush`
 * drops the body padding for a Table or a divided list, which bring
 * their own gutters. Cards size to their content.
 */
export function TelemetryPanel({
	title,
	meta,
	actions,
	children,
	className,
	flush = false,
}: {
	title: string;
	/** Quiet context beside the title ("57 runs"). */
	meta?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	flush?: boolean;
}) {
	return (
		<Card className={className}>
			<CardHeader title={title} meta={meta} actions={actions} />
			{flush ? children : <CardBody className="flex flex-col gap-3">{children}</CardBody>}
		</Card>
	);
}

/** What failed, and a retry. Inside a padded panel body. */
export function PanelError({
	what,
	error,
	onRetry,
}: {
	what: string;
	error: unknown;
	onRetry?: () => void;
}) {
	const detail = formatError(error);
	return (
		<div className="flex flex-col items-start gap-2">
			<p className="text-sm text-(--color-danger)">
				Couldn't load {what}.{detail ? ` ${detail}` : ""}
			</p>
			{onRetry ? (
				<Button variant="outline" size="sm" onClick={onRetry}>
					Retry
				</Button>
			) : null}
		</div>
	);
}

/** A quiet one-line empty note inside a padded panel body. */
export function PanelEmpty({ children }: { children: ReactNode }) {
	return <p className="text-sm text-(--color-text-3)">{children}</p>;
}

/** Loading rows in a padded panel body: the list's shape, not a spinner. */
export function PanelLoading({ rows = 4, className }: { rows?: number; className?: string }) {
	return <SkeletonRows rows={rows} className={cn("-mx-4 -my-2", className)} />;
}
