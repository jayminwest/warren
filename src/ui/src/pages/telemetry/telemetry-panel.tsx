import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Direction C panel primitive for the Telemetry page (warren-7197):
 * the bordered surface card every tab renders — a 13px semibold title
 * row with mono meta on the right, content below. Token variables only,
 * so dark and light themes both render from the same classes.
 */
export function TelemetryPanel({
	title,
	meta,
	children,
	className,
}: {
	title: string;
	/** Mono uppercase right-hand figure ("213 RUNS · 14 DAYS"). */
	meta?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"flex min-w-0 flex-col rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)",
				className,
			)}
		>
			<header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
				<h2 className="text-[13px] font-semibold leading-4 text-(--color-text)">{title}</h2>
				{meta !== undefined ? (
					<span className="font-mono text-[10px] tracking-[0.06em] leading-3 text-(--color-text-3)">
						{meta}
					</span>
				) : null}
			</header>
			<div className="flex w-full flex-col gap-3 p-4">{children}</div>
		</section>
	);
}

/**
 * The quiet placeholder every metric without an API surface renders —
 * a figure is never fabricated (pl-7e38 approach; see the topbar's
 * identical pattern). `title` names what will land the real figure.
 */
export function QuietFigure({ note, title }: { note?: string; title?: string }) {
	return (
		<span
			className="font-mono text-[24px] font-medium leading-7 text-(--color-text-3)"
			{...(title ? { title } : {})}
		>
			—{note !== undefined ? <span className="ml-1 text-[10px] leading-3">{note}</span> : null}
		</span>
	);
}
