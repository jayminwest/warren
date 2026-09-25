import { SlidersHorizontal } from "lucide-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import type { RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { stateLabel } from "@/components/ui/status.tsx";
import { cn } from "@/lib/utils.ts";

/*
 * Runs filter bar (warren-6419, rebuilt on the primitives in
 * warren-9474). One wrapping row of Select controls plus the id search.
 * On a phone the search stays visible and the selects fold behind a
 * Filters toggle that shows how many are active.
 */

/** State filter values. "active" = running + queued. */
export const STATE_FILTERS = [
	"all",
	"active",
	"running",
	"queued",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export interface PageFilters {
	state: StateFilter;
	agent: "all" | string;
	project: "all" | string;
	trigger: "all" | string;
	search: string;
}

export const NO_FILTERS: PageFilters = {
	state: "all",
	agent: "all",
	project: "all",
	trigger: "all",
	search: "",
};

export function matchesStateFilter(state: RunRow["state"], filter: StateFilter): boolean {
	if (filter === "all") return true;
	if (filter === "active") return state === "running" || state === "queued";
	return state === filter;
}

/** How many of the select filters (not the search) are narrowing the list. */
export function activeSelectCount(f: PageFilters): number {
	return [f.state, f.agent, f.project, f.trigger].filter((v) => v !== "all").length;
}

function stateOptionLabel(s: StateFilter): string {
	if (s === "all") return "Any state";
	if (s === "active") return "Active";
	return stateLabel(s);
}

interface RunsFilterBarProps {
	filters: PageFilters;
	setFilters: Dispatch<SetStateAction<PageFilters>>;
	agentNames: string[];
	projects: { id: string; gitUrl: string }[];
	triggers: string[];
}

export function RunsFilterBar({
	filters,
	setFilters,
	agentNames,
	projects,
	triggers,
}: RunsFilterBarProps) {
	const [open, setOpen] = useState(false);
	const selects = activeSelectCount(filters);
	const anyActive = selects > 0 || filters.search.trim().length > 0;
	const set = (patch: Partial<PageFilters>) => setFilters((f) => ({ ...f, ...patch }));

	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-4 py-3">
			<Input
				type="search"
				aria-label="Filter by run ID or seed"
				placeholder="Filter by run ID or seed"
				value={filters.search}
				onChange={(e) => set({ search: e.target.value })}
				className="w-auto flex-1 md:order-last md:ml-auto md:w-56 md:flex-none"
			/>
			<Button
				variant="outline"
				className="h-11 md:hidden"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<SlidersHorizontal aria-hidden />
				Filters
				{selects > 0 ? <span className="tabular-nums text-(--color-text-3)">{selects}</span> : null}
			</Button>
			<div
				className={cn(
					"grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:flex-wrap md:items-center",
					open ? "grid" : "hidden md:flex",
				)}
			>
				<Select
					aria-label="State"
					value={filters.state}
					onChange={(e) => set({ state: e.target.value as StateFilter })}
					wrapperClassName="md:w-36"
				>
					{STATE_FILTERS.map((s) => (
						<option key={s} value={s}>
							{stateOptionLabel(s)}
						</option>
					))}
				</Select>
				<Select
					aria-label="Agent"
					value={filters.agent}
					onChange={(e) => set({ agent: e.target.value })}
					wrapperClassName="md:w-40"
				>
					<option value="all">Any agent</option>
					{agentNames.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</Select>
				<Select
					aria-label="Project"
					value={filters.project}
					onChange={(e) => set({ project: e.target.value })}
					wrapperClassName="md:w-52"
				>
					<option value="all">Any project</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl.replace(/^https:\/\/github\.com\//, "")}
						</option>
					))}
				</Select>
				<Select
					aria-label="Trigger"
					value={filters.trigger}
					onChange={(e) => set({ trigger: e.target.value })}
					wrapperClassName="md:w-36"
				>
					<option value="all">Any trigger</option>
					{triggers.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</Select>
			</div>
			{anyActive ? (
				<Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
					Clear
				</Button>
			) : null}
		</div>
	);
}
