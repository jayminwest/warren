import { cn } from "@/lib/utils.ts";

/**
 * Shared horizontal meter bar (warren-67f2): a fixed label, a
 * `flex-1 min-w-0` track, and the percentage-width mark INSIDE the
 * track. The percentage must resolve against the track, not the whole
 * row — otherwise the 100% bar equals the panel width and the label +
 * gaps + value push the document into horizontal scroll.
 */
interface MeterBarProps {
	/** Percentage width (or px fallback) resolved against the track. */
	readonly width: string;
	/** Classes for the mark: height + color (no shrink-0 — the track clips). */
	readonly markClass: string;
	readonly label?: string;
	/** Extra classes for the label span, e.g. a fixed width. */
	readonly labelClass?: string;
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
	value,
	valueClass,
	title,
}: MeterBarProps) {
	return (
		<div className="flex w-full min-w-0 items-center gap-2.5">
			{label === undefined ? null : (
				<span className={cn("shrink-0 font-mono text-[11px] leading-[14px]", labelClass)}>
					{label}
				</span>
			)}
			<div className="min-w-0 flex-1">
				<div className={cn("rounded-[1px]", markClass)} style={{ width }} title={title} />
			</div>
			{value === undefined ? null : (
				<span
					className={cn("font-mono text-[11px] leading-[14px] text-(--color-text-3)", valueClass)}
				>
					{value}
				</span>
			)}
		</div>
	);
}
