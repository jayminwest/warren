import { Keyboard } from "lucide-react";
import type * as React from "react";
import {
	burnValue,
	healthLabel,
	runtimeValue,
} from "@/components/console/console-topbar.helpers.ts";
import type { ConsoleStats } from "@/components/console/use-console-stats.ts";
import { StatusDot } from "@/components/ui/status.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The console status strip (warren-4ed7, polished in warren-a8c9):
 * health, running, queued, spend rate, runtime. Sentence-case labels in
 * text-3, tabular values in text-2. A figure whose data is unavailable
 * renders a quiet "—" — never a fabricated number.
 */

function Stat({
	label,
	value,
	title,
	hideOnNarrow = false,
	children,
}: {
	label: string;
	value: string;
	title?: string;
	hideOnNarrow?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<span
			className={cn("flex shrink-0 items-center gap-1.5 text-xs", hideOnNarrow && "hidden sm:flex")}
			{...(title ? { title } : {})}
		>
			{children}
			<span className="text-(--color-text-3)">{label}</span>
			<span className="font-medium tabular-nums text-(--color-text-2)">{value}</span>
		</span>
	);
}

function HealthStat({ health }: { health: ConsoleStats["health"] }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5 text-xs" title="GET /healthz liveness">
			<StatusDot size="sm" tone={health === "ok" ? "ok" : health === "down" ? "err" : "idle"} />
			<span
				className={cn(
					health === "ok" ? "text-(--color-text-2)" : "text-(--color-text-3)",
					health === "down" && "text-(--color-danger)",
				)}
			>
				{healthLabel(health)}
			</span>
		</span>
	);
}

function count(value: number | null): string {
	return value === null ? "—" : String(value);
}

function Divider() {
	return <span aria-hidden className="h-3 w-px shrink-0 bg-(--color-border)" />;
}

export function ConsoleTopbar({
	stats,
	onOpenHelp,
}: {
	stats: ConsoleStats;
	onOpenHelp: () => void;
}) {
	const running = stats.runningCount ?? 0;
	return (
		<header className="flex h-10 w-full min-w-0 shrink-0 items-center gap-3.5 border-b border-(--color-border) px-6">
			<HealthStat health={stats.health} />
			<Divider />
			<Stat label="Running" value={count(stats.runningCount)}>
				{running > 0 ? <StatusDot state="running" size="sm" /> : null}
			</Stat>
			<Stat label="Queued" value={count(stats.queuedCount)} />
			<Stat
				label="Spend"
				value={burnValue(stats.burnUsdPerHour)}
				title={
					stats.burnUsdPerHour === null
						? "Spend rate unavailable (loading or read-only view)"
						: "Spend rate over the last 24 hours"
				}
			/>
			<span className="flex-1" />
			<Stat
				label="Runtime"
				value={runtimeValue(stats.runtime) ?? "—"}
				title="Boot-resolved runtime provider"
				hideOnNarrow
			/>
			<button
				type="button"
				onClick={onOpenHelp}
				aria-label="Keyboard shortcuts"
				title="Keyboard shortcuts (?)"
				className="rounded-xs p-1 text-(--color-text-3) transition-colors hover:bg-(--color-surface-raised) hover:text-(--color-text-2)"
			>
				<Keyboard className="size-4" />
			</button>
		</header>
	);
}

/**
 * The phone status strip (warren-3290): health, running, queued, spend —
 * left-packed with no spacer, on its own row under the brand bar.
 */
export function ConsoleMobileStatusStrip({ stats }: { stats: ConsoleStats }) {
	return (
		<header className="flex h-9 w-full shrink-0 items-center gap-3.5 overflow-clip border-b border-(--color-border) px-4">
			<HealthStat health={stats.health} />
			<Stat label="Running" value={count(stats.runningCount)} />
			<Stat label="Queued" value={count(stats.queuedCount)} />
			<Stat label="Spend" value={burnValue(stats.burnUsdPerHour)} />
		</header>
	);
}
