import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import { useTelemetryWindow } from "@/pages/telemetry/use-telemetry-window.tsx";

/**
 * Direction C panel primitive for the Telemetry page (warren-7197):
 * the bordered surface card every tab renders — a title row with mono
 * meta on the right, content below. Token variables only, so dark and
 * light themes both render from the same classes.
 *
 * Mobile chrome (warren-93cc): below md the header is a --color-thead
 * band with a mono 10px .08em uppercase title and a mono 9px right
 * meta slot, and the body tightens to 12px padding / 9px gap. The
 * hidden range selector's window surfaces here: the window label
 * ("14D") prefixes the meta below md. md+ renders exactly as before.
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
	const { days } = useTelemetryWindow();
	const mobileMeta = `${String(days)}D${meta !== undefined ? ` · ${meta}` : ""}`;
	return (
		<section
			className={cn(
				"flex min-w-0 flex-col rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)",
				className,
			)}
		>
			<header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-thead) px-3 py-2.5 md:bg-transparent md:px-4 md:py-3">
				<h2 className="font-mono text-[10px] leading-3 tracking-[0.08em] uppercase text-(--color-text) md:font-sans md:text-[13px] md:font-semibold md:leading-4 md:normal-case md:tracking-normal">
					{title}
				</h2>
				{meta !== undefined ? (
					<span className="hidden font-mono text-[10px] tracking-[0.06em] leading-3 text-(--color-text-3) md:inline">
						{meta}
					</span>
				) : null}
				<span className="font-mono text-[9px] leading-[11px] text-(--color-text-3) md:hidden">
					{mobileMeta}
				</span>
			</header>
			<div className="flex w-full flex-col gap-[9px] p-3 md:gap-3 md:p-4">{children}</div>
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
