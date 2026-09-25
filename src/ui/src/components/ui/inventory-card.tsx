import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils.ts";
import { stateLabel as humanState, StatusDot, stateTone, type Tone, toneText } from "./status.tsx";

/**
 * Shared phone inventory-row card (warren-dea8, polished in warren-9474):
 * below `md` an inventory table renders as a stack of these rows inside
 * the same card surface. Colour comes from the one status vocabulary in
 * `status.tsx` — a card either passes a wire `state` (preferred) or a
 * legacy `tone`.
 */

export type InventoryCardTone = "info" | "warning" | "success" | "danger" | "neutral" | "muted";

const LEGACY_TONES: Record<InventoryCardTone, Tone> = {
	info: "live",
	warning: "warn",
	success: "ok",
	danger: "err",
	neutral: "idle",
	muted: "idle",
};

/** A raw wire word ("pr_open") reads as sentence case; prose passes through. */
function labelOf(label: string): string {
	return /^[a-z_-]+$/.test(label) ? humanState(label) : label;
}

/** The phone arm of an inventory: a divided row list, hidden at `md` and up. */
export function InventoryCardList({ children }: { children: ReactNode }) {
	return <div className="flex flex-col divide-y divide-(--color-border) md:hidden">{children}</div>;
}

/**
 * One row card: a status cell, the identifier + subline column, and a
 * trailing figures column. An optional `meta` line and `children`
 * (actions, badges) render under the main line.
 */
export function InventoryRowCard({
	tone,
	state,
	stateLabel,
	title,
	titleTo,
	subline,
	figures,
	meta,
	children,
}: {
	tone?: InventoryCardTone;
	/** Wire state; picks the tone and breathes the dot while live. */
	state?: string;
	/** Short status word beside the dot. Omit for a dot-only row. */
	stateLabel?: string;
	/** Primary identifier (mono). */
	title: ReactNode;
	/** Link target for the title — the keyboard path to detail. */
	titleTo?: string;
	/** Quiet second line: agent · project · one extra. */
	subline?: ReactNode;
	/** Trailing right-aligned figures (elapsed, cost). */
	figures?: ReactNode;
	/** Quiet full-width meta line under the main row. */
	meta?: ReactNode;
	/** Kept for callers; every card uses the same padding now. */
	roomy?: boolean;
	/** Actions or badges on the meta line's trailing edge. */
	children?: ReactNode;
}) {
	const t: Tone =
		state !== undefined ? stateTone(state) : tone !== undefined ? LEGACY_TONES[tone] : "idle";
	const dot = <StatusDot state={state} tone={t} size="sm" />;
	const titleNode =
		titleTo !== undefined ? (
			<Link to={titleTo} className="truncate font-mono text-sm text-(--color-text) hover:underline">
				{title}
			</Link>
		) : (
			<span className="truncate font-mono text-sm text-(--color-text)">{title}</span>
		);

	return (
		<div className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-(--color-surface-hover)">
			<div className="flex min-w-0 items-center gap-3">
				{stateLabel !== undefined ? (
					<span className={cn("flex w-20 shrink-0 items-center gap-1.5 text-xs", toneText(t))}>
						{dot}
						<span className="truncate">{labelOf(stateLabel)}</span>
					</span>
				) : (
					<span className="flex shrink-0 items-center">{dot}</span>
				)}
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					{titleNode}
					{subline !== undefined ? (
						<span className="truncate text-xs text-(--color-text-3)">{subline}</span>
					) : null}
				</span>
				{figures !== undefined ? (
					<span className="flex shrink-0 flex-col items-end gap-0.5 text-right tabular-nums">
						{figures}
					</span>
				) : null}
			</div>
			{meta !== undefined || children !== undefined ? (
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					{meta !== undefined ? (
						<span className="min-w-0 flex-1 truncate text-xs text-(--color-text-3)">{meta}</span>
					) : (
						<span className="min-w-0 flex-1" />
					)}
					{children}
				</div>
			) : null}
		</div>
	);
}

/** A figure line inside the card's trailing column. */
export function CardFigure({ value, className }: { value: ReactNode; className?: string }) {
	return (
		<span className={cn("text-sm text-(--color-text-2) tabular-nums", className)}>{value}</span>
	);
}

/** A quieter figure under a CardFigure; `tone="warning"` tints a near-cap cost. */
export function CardFigureNote({
	value,
	tone = "default",
	className,
}: {
	value: ReactNode;
	tone?: "default" | "warning";
	className?: string;
}) {
	return (
		<span
			className={cn(
				"text-xs tabular-nums",
				tone === "warning" ? "text-(--color-warning)" : "text-(--color-text-3)",
				className,
			)}
		>
			{value}
		</span>
	);
}
