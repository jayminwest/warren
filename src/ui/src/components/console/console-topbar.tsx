import type { ConsoleStats } from "@/components/console/use-console-stats.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The 42px Direction C status strip (warren-4ed7): control-plane health,
 * RUNNING, QUEUE, BURN, RUNTIME, identity. Mono 10px figures; labels in
 * text-3, values in text-2. Figures whose API lands later render a quiet
 * "—" placeholder — never a fabricated number.
 */

function Stat({
	label,
	value,
	title,
	hideOnNarrow = false,
}: {
	label: string;
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
			<span className="w-max shrink-0 text-(--color-text-3)">{label}</span>
			<span className="w-max shrink-0 text-(--color-text-2)">{value}</span>
		</span>
	);
}

function HealthStat({ health }: { health: ConsoleStats["health"] }) {
	const label =
		health === "ok"
			? "CONTROL PLANE HEALTHY"
			: health === "down"
				? "CONTROL PLANE ERROR"
				: "CONTROL PLANE —";
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

/** BURN placeholder: the ops overview API (warren-d850) lands the figure. */
function BurnStat() {
	return (
		<Stat
			label="BURN"
			value="— / H"
			title="Spend rate lands with the ops overview API (warren-d850)"
			hideOnNarrow
		/>
	);
}

/** RUNTIME placeholder: no surface names the boot-resolved provider yet. */
function RuntimeStat() {
	return (
		<Stat
			label="RUNTIME"
			value="—"
			title="Runtime kind lands with the ops overview API (warren-d850)"
		/>
	);
}

export function ConsoleTopbar({ stats }: { stats: ConsoleStats }) {
	return (
		<header className="flex h-[42px] shrink-0 items-center gap-4 border-b border-(--color-border) px-4 sm:gap-[18px] sm:px-[22px]">
			<HealthStat health={stats.health} />
			<Stat
				label="RUNNING"
				value={stats.runningCount === null ? "—" : String(stats.runningCount)}
			/>
			<Stat label="QUEUE" value={stats.queuedCount === null ? "—" : String(stats.queuedCount)} />
			<BurnStat />
			<span className="flex-1" />
			<RuntimeStat />
			<IdentityStat />
		</header>
	);
}
