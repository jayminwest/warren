import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils.ts";

/**
 * Shared mobile inventory-row card (warren-dea8 / pl-7e38 step 20),
 * translated from the mobile artboards
 * (docs/ui-revamp/screens/mobile/*.jsx): one shared degradation pattern
 * where an inventory table renders as a stack of row cards below `md`
 * while the desktop table stays pixel-identical above it. Colors come
 * only from token variables, so the dark/light swap is automatic.
 */

export type InventoryCardTone = "info" | "warning" | "success" | "danger" | "neutral" | "muted";

const TONE_CLASS: Record<InventoryCardTone, { dot: string; text: string }> = {
	info: { dot: "bg-(--color-info)", text: "text-(--color-info)" },
	warning: { dot: "bg-(--color-warning)", text: "text-(--color-warning)" },
	success: { dot: "bg-(--color-success)", text: "text-(--color-success)" },
	danger: { dot: "bg-(--color-danger)", text: "text-(--color-danger)" },
	neutral: { dot: "bg-(--color-neutral)", text: "text-(--color-neutral)" },
	muted: { dot: "bg-(--color-text-3)", text: "text-(--color-text-3)" },
};

/**
 * The mobile arm of an inventory: compact rows inside the inventory's
 * existing bordered container, hidden ≥ md. Rows are separated by hair
 * borders like the artboard tables (single container, row list).
 */
export function InventoryCardList({ children }: { children: ReactNode }) {
	return <div className="flex flex-col md:hidden">{children}</div>;
}

/**
 * One row card. Layout mirrors the artboard rows: a leading state dot +
 * label, the title/subline column growing in the middle, and a trailing
 * figures column (small mono lines, right-aligned). An optional `meta`
 * row and `children` (actions, badges) render under the main line.
 */
export function InventoryRowCard({
	tone,
	stateLabel,
	title,
	titleTo,
	subline,
	figures,
	meta,
	children,
}: {
	tone: InventoryCardTone;
	/** Short state word next to the dot (e.g. "running"). */
	stateLabel: string;
	/** Primary mono identifier. */
	title: ReactNode;
	/** Optional link target for the title (keyboard path to detail). */
	titleTo?: string;
	/** Quiet second line: agent · project · extras. */
	subline?: ReactNode;
	/** Trailing right-aligned mono figures (elapsed, cost…). */
	figures?: ReactNode;
	/** Quiet full-width meta line under the main row. */
	meta?: ReactNode;
	/** Actions / badges rendered on the meta line's trailing edge. */
	children?: ReactNode;
}) {
	const toneClass = TONE_CLASS[tone];
	const titleNode =
		titleTo !== undefined ? (
			<Link
				to={titleTo}
				className="truncate font-mono text-[11px] leading-[13px] text-(--color-text) hover:underline"
			>
				{title}
			</Link>
		) : (
			<span className="truncate font-mono text-[11px] leading-[13px] text-(--color-text)">
				{title}
			</span>
		);

	return (
		<div className="flex flex-col gap-2 border-b border-(--color-border) px-2.5 py-2.5 last:border-b-0">
			<div className="flex min-w-0 items-center gap-2.5">
				<span className="flex w-[70px] shrink-0 items-center gap-[5px]">
					<span
						className={cn("h-[5px] w-[5px] shrink-0 rounded-full", toneClass.dot)}
						aria-hidden
					/>
					<span className={cn("truncate font-mono text-[9px] leading-[11px]", toneClass.text)}>
						{stateLabel}
					</span>
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-[2px]">
					{titleNode}
					{subline !== undefined ? (
						<span className="truncate font-mono text-[9px] leading-[11px] text-(--color-text-3)">
							{subline}
						</span>
					) : null}
				</span>
				{figures !== undefined ? (
					<span className="flex shrink-0 flex-col items-end gap-[2px] text-right">{figures}</span>
				) : null}
			</div>
			{meta !== undefined || children !== undefined ? (
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{meta !== undefined ? (
						<span className="min-w-0 flex-1 truncate font-mono text-[9px] leading-[11px] text-(--color-text-3)">
							{meta}
						</span>
					) : (
						<span className="min-w-0 flex-1" />
					)}
					{children}
				</div>
			) : null}
		</div>
	);
}

/** A quiet figure line inside the card's trailing column. */
export function CardFigure({ value, className }: { value: ReactNode; className?: string }) {
	return (
		<span className={cn("font-mono text-[10px] leading-[12px] text-(--color-text-2)", className)}>
			{value}
		</span>
	);
}

/** Small mono figure note (cost line under elapsed, etc.). */
export function CardFigureNote({ value, className }: { value: ReactNode; className?: string }) {
	return (
		<span className={cn("font-mono text-[9px] leading-[11px] text-(--color-text-3)", className)}>
			{value}
		</span>
	);
}
