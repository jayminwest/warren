/**
 * Cost analytics view (warren-cf63 / pl-b0c0 step 6).
 *
 * Centralized spend breakdown over `runs.cost_usd`. Renders a totals
 * header card + a date-range / project filter, then a grid of eight
 * dimension cards (date, project, plan, plot, run, agent, model,
 * provider) each showing a sortable-by-cost table of buckets.
 *
 * The server (`GET /analytics/cost`) returns every dimension in one
 * payload so the page is a single round-trip; the date dimension is
 * pre-sorted chronologically and the other seven are pre-sorted by
 * cost desc with a `key` tiebreaker. Buckets whose group key is null
 * (e.g. a run with no `plotId`) land in a `__none__` bucket per
 * dimension and render as an em-dash so the operator can see how
 * much spend is unattributed to that dimension.
 *
 * Filter state persists in the URL hash query (react-router's
 * `useSearchParams` over HashRouter) so deep links survive a refresh.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
	analyticsApi,
	COST_ANALYTICS_NONE_KEY,
	type CostBucket,
	type CostDimension,
	projectsApi,
} from "@/api/client.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import {
	responsiveCardHeaderRow,
	responsiveFormControl,
} from "@/components/ui/responsive.ts";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { formatCostUsd } from "./RunDetail.tsx";

const DIMENSIONS: { id: CostDimension; label: string; subtitle: string }[] = [
	{ id: "date", label: "By date", subtitle: "Daily spend (YYYY-MM-DD)" },
	{ id: "project", label: "By project", subtitle: "Spend per project" },
	{ id: "plan", label: "By plan", subtitle: "Spend per seeds plan" },
	{ id: "plot", label: "By plot", subtitle: "Spend per Plot" },
	{ id: "agent", label: "By agent", subtitle: "Spend per agent" },
	{ id: "model", label: "By model", subtitle: "Spend per provider model" },
	{ id: "provider", label: "By provider", subtitle: "Spend per runtime provider" },
	{ id: "run", label: "Top runs", subtitle: "Spend per run id" },
];

/**
 * Default date window: last 30 days. Mirrors the server's default
 * — kept here so the date input's value is populated even before
 * the first response arrives.
 */
function defaultFrom(): string {
	const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	return d.toISOString().slice(0, 10);
}

export function CostAnalyticsPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const projectId = searchParams.get("projectId") ?? "";
	const from = searchParams.get("from") ?? defaultFrom();
	const to = searchParams.get("to") ?? "";

	const updateParam = (k: string, v: string) => {
		const next = new URLSearchParams(searchParams);
		if (v === "") next.delete(k);
		else next.set(k, v);
		setSearchParams(next, { replace: true });
	};

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const analytics = useQuery({
		queryKey: ["analytics", "cost", { projectId, from, to }],
		queryFn: ({ signal }) =>
			analyticsApi.cost(
				{
					...(projectId !== "" ? { projectId } : {}),
					...(from !== "" ? { from: `${from}T00:00:00.000Z` } : {}),
					...(to !== "" ? { to: `${to}T23:59:59.999Z` } : {}),
				},
				signal,
			),
	});

	const projectLabels = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) {
			m.set(p.id, p.gitUrl.replace(/^https:\/\/github\.com\//, "") || p.id);
		}
		return m;
	}, [projects.data]);

	const data = analytics.data;
	const totals = data?.totals;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Cost analytics"
				description="Spend breakdown across runs.cost_usd. Defaults to the last 30 days."
			/>

			<Card>
				<CardHeader>
					<CardTitle>Filters</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap items-end gap-4">
						<div className="flex flex-col gap-1">
							<label
								htmlFor="ca-from"
								className="text-xs text-(--color-muted-foreground)"
							>
								From
							</label>
							<input
								id="ca-from"
								type="date"
								value={from}
								onChange={(e) => updateParam("from", e.target.value)}
								className={`rounded border border-(--color-border) bg-transparent px-2 ${responsiveFormControl}`}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label
								htmlFor="ca-to"
								className="text-xs text-(--color-muted-foreground)"
							>
								To
							</label>
							<input
								id="ca-to"
								type="date"
								value={to}
								onChange={(e) => updateParam("to", e.target.value)}
								className={`rounded border border-(--color-border) bg-transparent px-2 ${responsiveFormControl}`}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label
								htmlFor="ca-project"
								className="text-xs text-(--color-muted-foreground)"
							>
								Project
							</label>
							<select
								id="ca-project"
								value={projectId}
								onChange={(e) => updateParam("projectId", e.target.value)}
								className={`rounded border border-(--color-border) bg-transparent px-2 ${responsiveFormControl}`}
							>
								<option value="">All projects</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl.replace(/^https:\/\/github\.com\//, "") || p.id}
									</option>
								))}
							</select>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className={responsiveCardHeaderRow}>
					<CardTitle>
						{totals === undefined
							? "Loading…"
							: `${totals.runs} runs · ${formatCostUsd(totals.costUsd)}`}
					</CardTitle>
					{totals !== undefined ? (
						<span
							className="font-mono text-xs text-(--color-muted-foreground)"
							title={`${totals.priced} of ${totals.runs} runs have a recorded cost in this window`}
						>
							priced: {totals.priced} / {totals.runs}
						</span>
					) : null}
				</CardHeader>
			</Card>

			{analytics.isError ? (
				<Card>
					<CardContent className="py-6 text-sm text-(--color-destructive)">
						Failed to load cost analytics.{" "}
						{(analytics.error as Error | null)?.message ?? ""}
					</CardContent>
				</Card>
			) : null}

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{DIMENSIONS.map((dim) => (
					<BreakdownCard
						key={dim.id}
						title={dim.label}
						subtitle={dim.subtitle}
						dimension={dim.id}
						buckets={data?.breakdowns[dim.id] ?? []}
						loading={analytics.isLoading}
						projectLabels={projectLabels}
					/>
				))}
			</div>
		</div>
	);
}

function BreakdownCard({
	title,
	subtitle,
	dimension,
	buckets,
	loading,
	projectLabels,
}: {
	title: string;
	subtitle: string;
	dimension: CostDimension;
	buckets: CostBucket[];
	loading: boolean;
	projectLabels: Map<string, string>;
}) {
	// Cap rendered rows so a runaway dimension (e.g. 5000 unique runs)
	// doesn't blow up the page. The bucket array is pre-sorted server-
	// side by cost desc (or chronological for `date`), so the tail is
	// the long-tail of low-cost items.
	const cap = dimension === "run" ? 50 : 30;
	const visible = buckets.slice(0, cap);
	const hidden = buckets.length - visible.length;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
				<p className="text-xs text-(--color-muted-foreground)">{subtitle}</p>
			</CardHeader>
			<CardContent>
				{loading ? (
					<p className="text-sm text-(--color-muted-foreground)">Loading…</p>
				) : visible.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">No data in this window.</p>
				) : (
					<>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{labelForDimension(dimension)}</TableHead>
									<TableHead className="text-right">Cost</TableHead>
									<TableHead className="text-right">Runs</TableHead>
									<TableHead className="text-right">Priced</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{visible.map((b) => (
									<TableRow key={b.key}>
										<TableCell className="max-w-[260px] truncate">
											{renderBucketKey(dimension, b.key, projectLabels)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs">
											{formatCostUsd(b.costUsd)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
											{b.runs}
										</TableCell>
										<TableCell className="whitespace-nowrap text-right font-mono text-xs text-(--color-muted-foreground)">
											{b.priced}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						{hidden > 0 ? (
							<p className="mt-2 text-xs text-(--color-muted-foreground)">
								+{hidden} more (long tail truncated)
							</p>
						) : null}
					</>
				)}
			</CardContent>
		</Card>
	);
}

function labelForDimension(dim: CostDimension): string {
	switch (dim) {
		case "date":
			return "Date";
		case "project":
			return "Project";
		case "plan":
			return "Plan";
		case "plot":
			return "Plot";
		case "run":
			return "Run";
		case "agent":
			return "Agent";
		case "model":
			return "Model";
		case "provider":
			return "Provider";
	}
}

function renderBucketKey(
	dimension: CostDimension,
	key: string,
	projectLabels: Map<string, string>,
): React.ReactNode {
	if (key === COST_ANALYTICS_NONE_KEY) {
		return <span className="text-(--color-muted-foreground)">—</span>;
	}
	switch (dimension) {
		case "project":
			return (
				<Link
					to={`/projects/${encodeURIComponent(key)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{projectLabels.get(key) ?? key}
				</Link>
			);
		case "plot":
			return (
				<Link
					to={`/plots/${encodeURIComponent(key)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{key}
				</Link>
			);
		case "run":
			return (
				<Link
					to={`/runs/${encodeURIComponent(key)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{key}
				</Link>
			);
		case "plan":
			// `key` is the seeds plan id (pl-XXXX), not a plan-run id.
			// No deep-link target in the UI; render as monospace text.
			return <span className="font-mono text-xs">{key}</span>;
		case "agent":
			return (
				<Link
					to={`/agents/${encodeURIComponent(key)}`}
					className="text-sm underline-offset-2 hover:underline"
				>
					{key}
				</Link>
			);
		default:
			return <span className="font-mono text-xs">{key}</span>;
	}
}
