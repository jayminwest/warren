import { AlertTriangle, CheckCircle2, Plus, Radio } from "lucide-react";
import type * as React from "react";
import { Link } from "react-router-dom";
import type { PlanRunRow, RunRow } from "@/api/types.ts";
import { Card } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { PrChip, StatusDot } from "@/components/ui/status.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { runTitle } from "@/lib/run-title.ts";
import { cn, relativeTime } from "@/lib/utils.ts";
import { isLongRun, runElapsedMs, shortDuration } from "./home.helpers.ts";

/**
 * The three "now" cards on Home (warren-44a2): what is running, what
 * needs a human, and what shipped in the window. Each shows up to four
 * rows and links through to the full list.
 */

const MAX_ROWS = 4;

function NowCard({
	icon,
	title,
	count,
	moreTo,
	loading,
	empty,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	count: number;
	moreTo: string;
	loading: boolean;
	empty: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Card className="flex flex-col">
			<div className="flex h-11 items-center gap-2 px-4">
				{icon}
				<h2 className="text-sm font-medium text-(--color-text)">{title}</h2>
				<span className="text-sm tabular-nums text-(--color-text-3)">{loading ? "" : count}</span>
				<span className="flex-1" />
				{count > MAX_ROWS ? (
					<Link to={moreTo} className="text-xs text-(--color-text-3) hover:text-(--color-text)">
						View all
					</Link>
				) : null}
			</div>
			<div className="flex flex-col px-1.5 pb-1.5">
				{loading ? (
					<div className="flex flex-col gap-2 px-2.5 pb-2">
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-4 w-1/2" />
					</div>
				) : count === 0 ? (
					<div className="px-2.5 pt-1 pb-3 text-sm text-(--color-text-3)">{empty}</div>
				) : (
					children
				)}
			</div>
		</Card>
	);
}

function MiniRow({
	to,
	state,
	title,
	sub,
	children,
}: {
	to: string;
	state: string;
	title: string;
	sub: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex h-12 items-center gap-2.5 rounded-sm px-2.5 hover:bg-(--color-surface-raised)">
			<StatusDot state={state} />
			<Link to={to} className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm text-(--color-text)">{title}</span>
				<span className="truncate text-xs text-(--color-text-3)">{sub}</span>
			</Link>
			{children}
		</div>
	);
}

export function NowCards({
	runs,
	livePlans,
	attention,
	shipped,
	now,
	p95Ms,
	loading,
	repoOf,
}: {
	runs: readonly RunRow[];
	livePlans: readonly PlanRunRow[];
	attention: readonly RunRow[];
	shipped: readonly RunRow[];
	now: number;
	p95Ms: number | null;
	loading: boolean;
	repoOf: (projectId: string | null) => string | null;
}) {
	const caps = useCapabilities();
	const sub = (r: RunRow): string => repoOf(r.projectId) ?? r.agentName;
	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<NowCard
				icon={<Radio aria-hidden className="size-4 text-(--color-info)" />}
				title="Running now"
				count={runs.length + livePlans.length}
				moreTo="/operations"
				loading={loading}
				empty={
					<span className="flex flex-col items-start gap-2.5">
						Nothing is running.
						{caps.can("dispatch") ? (
							<Link
								to="/dispatch"
								className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-(--color-border) px-2.5 text-xs font-medium text-(--color-text-2) hover:border-(--color-border-strong) hover:text-(--color-text)"
							>
								<Plus className="size-3.5" />
								New run
							</Link>
						) : null}
					</span>
				}
			>
				{runs.slice(0, MAX_ROWS).map((r) => (
					<MiniRow key={r.id} to={`/runs/${r.id}`} state={r.state} title={runTitle(r)} sub={sub(r)}>
						<span
							className={cn(
								"shrink-0 text-xs tabular-nums",
								isLongRun(r, now, p95Ms) ? "text-(--color-warning)" : "text-(--color-info)",
							)}
						>
							{r.state === "queued" ? "Queued" : shortDuration(runElapsedMs(r, now))}
						</span>
					</MiniRow>
				))}
				{livePlans.slice(0, Math.max(0, MAX_ROWS - runs.length)).map((p) => (
					<MiniRow
						key={p.id}
						to={`/plan-runs/${p.id}`}
						state={p.state}
						title={`Plan ${p.planId ?? "(issue list)"}`}
						sub={repoOf(p.projectId) ?? "Plan run"}
					/>
				))}
			</NowCard>

			<NowCard
				icon={<AlertTriangle aria-hidden className="size-4 text-(--color-warning)" />}
				title="Needs attention"
				count={attention.length}
				moreTo="/runs"
				loading={loading}
				empty="Nothing needs you. Failures and long runs show here."
			>
				{attention.slice(0, MAX_ROWS).map((r) => (
					<MiniRow key={r.id} to={`/runs/${r.id}`} state={r.state} title={runTitle(r)} sub={sub(r)}>
						<span className="shrink-0 text-xs text-(--color-text-3)">
							{r.state === "running"
								? `Long · ${shortDuration(runElapsedMs(r, now))}`
								: relativeTime(r.endedAt)}
						</span>
					</MiniRow>
				))}
			</NowCard>

			<NowCard
				icon={<CheckCircle2 aria-hidden className="size-4 text-(--color-merge)" />}
				title="Shipped"
				count={shipped.length}
				moreTo="/runs"
				loading={loading}
				empty="No merged pull requests in this window yet."
			>
				{shipped.slice(0, MAX_ROWS).map((r) => (
					<MiniRow key={r.id} to={`/runs/${r.id}`} state="merged" title={runTitle(r)} sub={sub(r)}>
						{r.prUrl ? <PrChip url={r.prUrl} lifecycle={r.prState} compact /> : null}
					</MiniRow>
				))}
			</NowCard>
		</div>
	);
}
