import { cn } from "@/lib/utils.ts";

/**
 * Shared horizontal meter bar (warren-67f2): a fixed label, a
 * `flex-1 min-w-0` track, and the percentage-width mark INSIDE the
 * track. The percentage must resolve against the track, not the whole
 * row — otherwise the 100% bar equals the panel width and the label +
 * gaps + value push the document into horizontal scroll.
 *
 * Labels are sans; pass `mono` when the label is a machine identifier
 * (a directory path, a run id). Values use tabular numerals.
 */
interface MeterBarProps {
	/** Percentage width (or px fallback) resolved against the track. */
	readonly width: string;
	/** Classes for the mark: height + color (no shrink-0 — the track clips). */
	readonly markClass: string;
	readonly label?: string;
	/** Extra classes for the label span, e.g. a fixed width. */
	readonly labelClass?: string;
	readonly mono?: boolean;
	readonly value?: string;
	/** Extra classes for the value span. */
	readonly valueClass?: string;
	readonly title?: string;
}

export function MeterBar({
	width,
	markClass,
	label,
	labelClass,
	mono = false,
	value,
	valueClass,
	title,
}: MeterBarProps) {
	return (
		<div className="flex w-full min-w-0 items-center gap-3" title={title}>
			{label === undefined ? null : (
				<span
					className={cn(
						"shrink-0 truncate text-(--color-text-2)",
						mono ? "font-mono text-xs" : "text-sm",
						labelClass,
					)}
				>
					{label}
				</span>
			)}
			<div className="min-w-0 flex-1">
				<div className={cn("rounded-xs", markClass)} style={{ width }} />
			</div>
			{value === undefined ? null : (
				<span
					className={cn(
						"shrink-0 text-right text-sm text-(--color-text-2) tabular-nums",
						valueClass,
					)}
				>
					{value}
				</span>
			)}
		</div>
	);
}

/** Share of `max` as a meter width, with a small floor so a mark shows. */
export function meterWidth(value: number, max: number): string {
	return max > 0 ? `${Math.max(3, Math.round((value / max) * 100))}%` : "0%";
}
