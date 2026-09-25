import { cn } from "@/lib/utils.ts";

export interface SegmentedOption<V extends string> {
	value: V;
	label: string;
	count?: number;
}

/**
 * Segmented control (warren-9474): a small set of mutually exclusive
 * choices — a time window, a view mode, a filter. Each option is a
 * pressed-state button, so Tab reaches it and Space/Enter selects.
 */
export function Segmented<V extends string>({
	options,
	value,
	onChange,
	label,
	size = "md",
	className,
}: {
	options: ReadonlyArray<SegmentedOption<V>>;
	value: V;
	onChange: (value: V) => void;
	label: string;
	size?: "sm" | "md";
	className?: string;
}) {
	return (
		<fieldset
			className={cn(
				"m-0 inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm border border-(--color-border) bg-(--color-bg) p-0.5",
				className,
			)}
		>
			<legend className="sr-only">{label}</legend>
			{options.map((o) => {
				const isActive = o.value === value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={isActive}
						onClick={() => onChange(o.value)}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-xs px-2.5 font-medium whitespace-nowrap transition-colors",
							size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
							isActive
								? "bg-(--color-surface-hover) text-(--color-text) shadow-sm"
								: "text-(--color-text-3) hover:text-(--color-text-2)",
						)}
					>
						{o.label}
						{o.count !== undefined ? (
							<span className="text-xs text-(--color-text-3) tabular-nums">{o.count}</span>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}
