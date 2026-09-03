import {
	burnValue,
	healthLabel,
	runtimeValue,
} from "@/components/console/console-topbar.helpers.ts";
import type { ConsoleStats } from "@/components/console/use-console-stats.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The 42px Direction C status strip (warren-4ed7): health, RUNNING, QUEUE,
 * BURN, RUNTIME, identity. Mono 10px figures; labels in text-3, values in
 * text-2. Figures whose data is unavailable render a quiet "—" placeholder —
 * never a fabricated number.
 */

function Stat({
	label,
	shortLabel,
	value,
	title,
	hideOnNarrow = false,
}: {
	label: string;
	/** Compact artboard spelling below sm (e.g. "RUN" for "RUNNING"). */
	shortLabel?: string;
	value: string;
	/** Hover hint, e.g. which upcoming issue lands the real figure. */
	title?: string;
	hideOnNarrow?: boolean;
}) {
	return (
		<span
			className={cn(
				"flex items-center gap-[7px] font-mono text-[10px] leading-3",
				hideOnNarrow && "hidden sm:flex",
			)}
			{...(title ? { title } : {})}
		>
			{shortLabel === undefined ? (
				<span className="w-max shrink-0 text-(--color-text-3)">{label}</span>
			) : (
				<>
					<span className="w-max shrink-0 text-(--color-text-3) sm:hidden">{shortLabel}</span>
					<span className="w-max shrink-0 text-(--color-text-3) max-sm:hidden">{label}</span>
				</>
			)}
			<span className="w-max shrink-0 text-(--color-text-2)">{value}</span>
		</span>
	);
}

function HealthStat({ health }: { health: ConsoleStats["health"] }) {
	const label = healthLabel(health);
	return (
		<span className="flex items-center gap-[7px]" title="GET /healthz liveness">
			<span
				className={cn(
					"h-1.5 w-1.5 shrink-0 rounded-full",
					health === "ok" && "bg-(--color-success)",
					health === "down" && "bg-(--color-danger)",
					health === "unknown" && "bg-(--color-text-3)",
				)}
				aria-hidden
			/>
			<span
				className={cn(
					"font-mono text-[10px] leading-3",
					health === "ok" ? "text-(--color-text-2)" : "text-(--color-text-3)",
				)}
			>
				{label}
			</span>
		</span>
	);
}

function IdentityStat() {
	const caps = useCapabilities();
	const identity = caps.status === "ready" ? caps.identity : null;
	return (
		<Stat
			label="IDENTITY"
			value={identity === "operator" ? "OPERATOR" : identity === null ? "—" : "SPECTATOR"}
			hideOnNarrow
		/>
	);
}

/** BURN: ops-overview spend rate (warren-d6ea); "—" while loading or spectator. */
function BurnStat({ burnUsdPerHour }: { burnUsdPerHour: ConsoleStats["burnUsdPerHour"] }) {
	return (
		<Stat
			label="BURN"
			value={burnValue(burnUsdPerHour)}
			title={
				burnUsdPerHour === null
					? "Spend rate unavailable (loading or spectator view)"
					: "Spend rate over the last 24 hours"
			}
		/>
	);
}

/** RUNTIME: boot-resolved provider off `GET /instance` (warren-d6ea). */
function RuntimeStat({ runtime }: { runtime: ConsoleStats["runtime"] }) {
	return (
		<Stat
			label="RUNTIME"
			value={runtimeValue(runtime) ?? "—"}
			title="Boot-resolved runtime provider"
			hideOnNarrow
		/>
	);
}

export function ConsoleTopbar({ stats }: { stats: ConsoleStats }) {
	return (
		<header className="flex h-[42px] w-full min-w-0 flex-1 shrink-0 items-center gap-4 border-b border-(--color-border) px-3.5 sm:gap-[18px] md:px-6">
			<HealthStat health={stats.health} />
			<Stat
				label="RUNNING"
				shortLabel="RUN"
				value={stats.runningCount === null ? "—" : String(stats.runningCount)}
			/>
			<Stat
				label="QUEUE"
				shortLabel="QUE"
				value={stats.queuedCount === null ? "—" : String(stats.queuedCount)}
			/>
			<BurnStat burnUsdPerHour={stats.burnUsdPerHour} />
			<span className="flex-1" />
			<RuntimeStat runtime={stats.runtime} />
			<IdentityStat />
		</header>
	);
}

/**
 * The 34px phone status strip (warren-3290, docs/ui-revamp/screens/mobile/
 * operations.jsx): exactly the four mobile figures — HEALTHY, RUN, QUE, BURN —
 * left-packed with no spacer, on its own row under the brand bar.
 */
export function ConsoleMobileStatusStrip({ stats }: { stats: ConsoleStats }) {
	return (
		<header className="flex h-[34px] w-full shrink-0 items-center gap-3.5 overflow-clip border-b border-(--color-border) px-3.5">
			<HealthStat health={stats.health} />
			<Stat
				label="RUNNING"
				shortLabel="RUN"
				value={stats.runningCount === null ? "—" : String(stats.runningCount)}
			/>
			<Stat
				label="QUEUE"
				shortLabel="QUE"
				value={stats.queuedCount === null ? "—" : String(stats.queuedCount)}
			/>
			<BurnStat burnUsdPerHour={stats.burnUsdPerHour} />
		</header>
	);
}
