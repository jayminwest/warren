import { useState } from "react";
import { EVENT_STREAMS, type ProjectRow } from "@/api/types.ts";
import { FilterPill } from "@/components/ui/filter-pill.tsx";
import { Input } from "@/components/ui/input.tsx";
import { responsiveFormControl } from "@/components/ui/responsive.ts";
import { cn } from "@/lib/utils.ts";
import type { FilterState } from "./event-explorer-export.ts";
import { TIME_RANGES } from "./event-explorer-format.ts";

export const STREAM_FILTERS: readonly { id: string; label: string }[] = [
	{ id: "all", label: "ALL" },
	...EVENT_STREAMS.map((s) => ({ id: s, label: s.toUpperCase() })),
];

/*
 * Mobile filter chrome (warren-fa27 / pl-4ab6): below md the wrapped
 * strip would stack ~4 rows of chrome. Instead one non-wrapping
 * overflow-x chip row carries the stream pills plus the range presets
 * as chips, and the run-id / kind / project inputs fold behind a
 * "Filters" disclosure. The md+ strip is unchanged. The mock drops
 * Export/Follow entirely; we keep them as compact icon-only buttons.
 */
export function MobileFilterStrip({
	state,
	patch,
	projects,
}: {
	state: FilterState;
	patch: (next: Partial<FilterState>) => void;
	projects: readonly ProjectRow[] | undefined;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-t border border-(--color-border) bg-(--color-surface) px-2.5 md:hidden">
			<div className="flex items-center gap-2 overflow-x-auto py-2">
				<FilterPill
					label={open ? "Filters −" : "Filters +"}
					active={open}
					aria-expanded={open}
					onClick={() => setOpen((prev) => !prev)}
					className="shrink-0 rounded-sm font-mono text-[10px] leading-3"
				/>
				{STREAM_FILTERS.map((f) => (
					<FilterPill
						key={f.id}
						label={f.label}
						active={state.stream === f.id}
						onClick={() => patch({ stream: f.id })}
						className="shrink-0 rounded-sm font-mono text-[10px] leading-3"
					/>
				))}
				{TIME_RANGES.map((r) => (
					<FilterPill
						key={r.id}
						label={r.label}
						active={state.rangeId === r.id}
						onClick={() => patch({ rangeId: r.id })}
						className="shrink-0 rounded-sm font-mono text-[10px] leading-3"
					/>
				))}
			</div>
			{open && (
				<div className="flex flex-col gap-2 pb-2">
					<Input
						value={state.runId}
						onChange={(e) => patch({ runId: e.target.value })}
						placeholder="run id"
						aria-label="Filter by run id"
						className={cn(responsiveFormControl, "font-mono text-base")}
					/>
					<Input
						value={state.kind}
						onChange={(e) => patch({ kind: e.target.value })}
						placeholder="kind"
						aria-label="Filter by event kind"
						className={cn(responsiveFormControl, "font-mono text-base")}
					/>
					{projects !== undefined && (
						<select
							value={state.projectId}
							onChange={(e) => patch({ projectId: e.target.value })}
							aria-label="Filter by project"
							className={cn(
								responsiveFormControl,
								"rounded-sm border border-(--color-border) bg-(--color-bg) px-2 font-mono text-(--color-text-2) text-base",
							)}
						>
							<option value="">all projects</option>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.id}
								</option>
							))}
						</select>
					)}
				</div>
			)}
		</div>
	);
}
