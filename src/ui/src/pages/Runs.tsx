import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { agentsApi, projectsApi, runsApi } from "@/api/client.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "./RunDetail.tsx";

// Cost column is on by default (warren-a7ec): pi runs are the common
// runtime today and hydrate `costUsd` via in-stream extraction
// (warren-17a4), so the column carries signal for most installs. The
// toggle remains as a hide option for operators who want to recover the
// horizontal space; localStorage persists the choice.
const COST_COLUMN_LS_KEY = "warren.runsList.showCostColumn";

type Filter = "all" | { kind: "agent"; value: string } | { kind: "project"; value: string };
type SortKey = "started" | "cost";
type SortDir = "asc" | "desc";

export function RunsPage() {
	const [filter, setFilter] = useState<Filter>("all");
	const [sort, setSort] = useState<SortKey>("started");
	const [dir, setDir] = useState<SortDir>("desc");
	const [showCost, setShowCost] = useState<boolean>(() => {
		if (typeof window === "undefined") return true;
		const stored = window.localStorage.getItem(COST_COLUMN_LS_KEY);
		// Default to on; only "0" hides the column.
		return stored !== "0";
	});

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(COST_COLUMN_LS_KEY, showCost ? "1" : "0");
	}, [showCost]);

	const filterApi = {
		...(filter === "all" ? {} : { [filter.kind]: filter.value }),
		sort,
		dir,
	};
	const runs = useQuery({
		queryKey: ["runs", filter, sort, dir],
		queryFn: ({ signal }) => runsApi.list(filterApi, signal),
		refetchInterval: 5000,
	});

	// Click cycles: inactive → desc → asc → (back to started/desc default).
	const toggleSort = (key: SortKey): void => {
		if (sort !== key) {
			setSort(key);
			setDir("desc");
			return;
		}
		if (dir === "desc") {
			setDir("asc");
			return;
		}
		// asc → reset to default (started/desc)
		setSort("started");
		setDir("desc");
	};
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list({}, signal),
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const costTotals = useMemo(() => {
		let total = 0;
		let priced = 0;
		for (const r of runs.data?.runs ?? []) {
			if (r.costUsd !== null) {
				total += r.costUsd;
				priced += 1;
			}
		}
		return { total, priced };
	}, [runs.data]);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
					<p className="text-sm text-(--color-muted-foreground)">
						Agent runs dispatched into burrow sandboxes.
					</p>
				</div>
				<Link to="/runs/new">
					<Button>Dispatch a run</Button>
				</Link>
			</header>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<label className="ml-1 flex items-center gap-1 text-xs text-(--color-muted-foreground)">
						<input
							type="checkbox"
							checked={showCost}
							onChange={(e) => setShowCost(e.target.checked)}
						/>
						Show cost
					</label>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				<FilterPill
					active={filter === "all"}
					label="All"
					onClick={() => setFilter("all")}
				/>
				{agents.data?.agents.map((a) => (
					<FilterPill
						key={`a-${a.name}`}
						active={filter !== "all" && filter.kind === "agent" && filter.value === a.name}
						label={`agent: ${a.name}`}
						onClick={() => setFilter({ kind: "agent", value: a.name })}
					/>
				))}
				{projects.data?.projects.map((p) => (
					<FilterPill
						key={`p-${p.id}`}
						active={filter !== "all" && filter.kind === "project" && filter.value === p.id}
						label={`project: ${p.gitUrl.replace(/^https:\/\/github\.com\//, "")}`}
						onClick={() => setFilter({ kind: "project", value: p.id })}
					/>
				))}
			</div>

			<Card>
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
					<CardTitle>{runs.data?.runs.length ?? 0} runs</CardTitle>
					{showCost && costTotals.priced > 0 ? (
						<span
							className="font-mono text-xs text-(--color-muted-foreground)"
							title={`${costTotals.priced} of ${runs.data?.runs.length ?? 0} runs have a recorded cost`}
						>
							total: {formatCostUsd(costTotals.total)}
						</span>
					) : null}
				</CardHeader>
				<CardContent className="p-0">
					{runs.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : runs.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{runs.error instanceof Error ? runs.error.message : String(runs.error)}
						</p>
					) : runs.data?.runs.length === 0 ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">
							No runs match this filter. Dispatch one above.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="whitespace-nowrap">State</TableHead>
									<TableHead className="whitespace-nowrap">ID</TableHead>
									<TableHead className="whitespace-nowrap">Agent</TableHead>
									<TableHead className="whitespace-nowrap">Project</TableHead>
									<TableHead className="whitespace-nowrap">
										<SortHeader
											label="Started"
											active={sort === "started"}
											dir={dir}
											onClick={() => toggleSort("started")}
										/>
									</TableHead>
									{showCost ? (
										<TableHead className="whitespace-nowrap text-right">
											<SortHeader
												label="Cost"
												active={sort === "cost"}
												dir={dir}
												align="right"
												onClick={() => toggleSort("cost")}
											/>
										</TableHead>
									) : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.data?.runs.map((r) => (
									<TableRow key={r.id}>
										<TableCell>
											<StateBadge state={r.state} />
										</TableCell>
										<TableCell>
											<Link
												to={`/runs/${encodeURIComponent(r.id)}`}
												className="font-mono text-xs underline-offset-2 hover:underline"
											>
												{r.id}
											</Link>
										</TableCell>
										<TableCell className="whitespace-nowrap">{r.agentName}</TableCell>
										<TableCell className="whitespace-nowrap font-mono text-xs">
											{r.projectId === null ? (
												<span className="italic text-(--color-muted-foreground)">
													(deleted project)
												</span>
											) : (
												(projectIndex.get(r.projectId) ?? r.projectId)
											)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
											{relativeTime(r.startedAt)}
										</TableCell>
										{showCost ? (
											<TableCell className="whitespace-nowrap text-right font-mono text-xs">
												{r.costUsd !== null ? (
													formatCostUsd(r.costUsd)
												) : (
													<span className="text-(--color-muted-foreground)">—</span>
												)}
											</TableCell>
										) : null}
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function SortHeader({
	label,
	active,
	dir,
	align = "left",
	onClick,
}: {
	label: string;
	active: boolean;
	dir: SortDir;
	align?: "left" | "right";
	onClick: () => void;
}) {
	const Icon = dir === "asc" ? ChevronUp : ChevronDown;
	return (
		<button
			type="button"
			onClick={onClick}
			className={`inline-flex items-center gap-1 transition-colors hover:text-(--color-fg) ${
				align === "right" ? "ml-auto" : ""
			} ${active ? "text-(--color-fg)" : ""}`}
		>
			{label}
			{active ? <Icon className="h-3 w-3" /> : null}
		</button>
	);
}

function FilterPill({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`rounded-full border px-3 py-1 text-xs transition-colors ${
				active
					? "bg-(--color-primary) text-(--color-primary-foreground)"
					: "bg-(--color-card) hover:bg-(--color-accent)"
			}`}
		>
			{label}
		</button>
	);
}
