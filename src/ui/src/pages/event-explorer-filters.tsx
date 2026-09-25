import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { EVENT_STREAMS, type ProjectRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { Select } from "@/components/ui/select.tsx";
import { cn } from "@/lib/utils.ts";
import type { FilterState } from "./event-explorer-export.ts";
import { TIME_RANGES } from "./event-explorer-format.ts";

/**
 * Event explorer filters (warren-9474): stream and time window as
 * segmented controls, then run id, kind, and project. One bar at every
 * width — it wraps on a phone, where the three text filters fold behind
 * a "Filters" toggle so the list stays on screen.
 */

const STREAM_OPTIONS = [
	{ value: "all", label: "All" },
	...EVENT_STREAMS.map((s) => ({ value: s, label: s })),
];

const RANGE_OPTIONS = TIME_RANGES.map((r) => ({ value: r.id, label: r.label }));

export function EventFilters({
	state,
	patch,
	projects,
}: {
	state: FilterState;
	patch: (next: Partial<FilterState>) => void;
	projects: readonly ProjectRow[] | undefined;
}) {
	const [open, setOpen] = useState(false);
	const activeText = [state.runId, state.kind, state.projectId].filter((v) => v !== "").length;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Segmented
				label="Stream"
				options={STREAM_OPTIONS}
				value={state.stream}
				onChange={(stream) => patch({ stream })}
			/>
			<Segmented
				label="Time window"
				options={RANGE_OPTIONS}
				value={state.rangeId}
				onChange={(rangeId) => patch({ rangeId })}
			/>
			<Button
				variant="outline"
				size="sm"
				className="md:hidden"
				aria-expanded={open}
				onClick={() => setOpen((prev) => !prev)}
			>
				<SlidersHorizontal aria-hidden />
				Filters{activeText > 0 ? ` · ${activeText}` : ""}
			</Button>
			<div
				className={cn(
					"w-full flex-wrap items-center gap-2 md:ml-auto md:flex md:w-auto",
					open ? "flex" : "hidden",
				)}
			>
				<Input
					value={state.runId}
					onChange={(e) => patch({ runId: e.target.value })}
					placeholder="Run id"
					aria-label="Filter by run id"
					className="font-mono md:w-40"
				/>
				<Input
					value={state.kind}
					onChange={(e) => patch({ kind: e.target.value })}
					placeholder="Event kind"
					aria-label="Filter by event kind"
					className="font-mono md:w-36"
				/>
				{projects !== undefined ? (
					<Select
						value={state.projectId}
						onChange={(e) => patch({ projectId: e.target.value })}
						aria-label="Filter by project"
						wrapperClassName="w-full md:w-44"
					>
						<option value="">All projects</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.id}
							</option>
						))}
					</Select>
				) : null}
			</div>
		</div>
	);
}
