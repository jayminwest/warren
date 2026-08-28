import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * Section scaffolding for the Dispatch plan walk form
 * (`src/ui/src/pages/dispatch-plan/walk-form.tsx`).
 *
 * Mobile arm (pl-4ab6 / warren-9e94): below md each form section renders
 * inside a MobileCard — its own card with a --color-thead title bar, ported
 * from warren-5cf7's settled dispatch treatment; at md+ the wrapper
 * collapses via `md:contents` so the single-card desktop layout and the
 * section descriptions stay untouched.
 */

export const labelClass = "text-[10px] font-medium leading-3 text-(--color-text-2)";
export const hintClass = "font-mono text-[9px] leading-3 text-(--color-text-3)";

export function Section({
	title,
	description,
	children,
	divider = "both",
}: {
	title: string;
	description: string;
	children: ReactNode;
	/** Where the section's bottom hairline renders: both arms, md+ only, or never. */
	divider?: "both" | "md" | "none";
}) {
	return (
		<section
			className={cn(
				"flex flex-col",
				divider === "both" && "border-b border-(--color-border)",
				divider !== "none" && "md:border-b md:border-(--color-border)",
			)}
		>
			{/* Desktop header — below md the card's --color-thead bar replaces it. */}
			<div className="hidden md:flex md:flex-col md:gap-[3px] md:px-[15px] md:pt-[15px] md:pb-[13px]">
				<h2 className="text-[11px] font-semibold leading-[14px] text-(--color-text)">{title}</h2>
				<p className="text-[10px] leading-3 text-(--color-text-3)">{description}</p>
			</div>
			<div className="flex flex-col px-3 py-3 md:px-[15px] md:py-0 md:pb-[15px]">{children}</div>
		</section>
	);
}

export function MobileCard({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) md:contents">
			<div className="flex items-center border-b border-(--color-border) bg-(--color-thead) px-3 py-2.5 md:hidden">
				<h2 className="text-[12px] font-semibold leading-[15px] text-(--color-text)">{title}</h2>
			</div>
			{children}
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-[5px]">
			<span className={labelClass}>{label}</span>
			{children}
			{hint ? <p className={hintClass}>{hint}</p> : null}
		</div>
	);
}
