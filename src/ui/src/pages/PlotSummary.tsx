import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { plotsApi } from "@/api/client.ts";
import type {
	PlotSummaryArtifact,
	PlotSummaryDecision,
	PlotSummaryLinkedCommit,
	PlotSummaryLinkedPr,
	PlotSummaryLinkedSeed,
	PlotSummaryTimelineEntry,
} from "@/api/types.ts";
import { PlotStatusBadge } from "@/components/PlotStatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { formatTimestamp } from "@/lib/utils.ts";

/**
 * `/plots/:id/summary` — institutional-memory artifact view
 * (warren-8917 / pl-0344 step 15). Renders the curated payload from
 * `GET /plots/:id/summary`: formatted intent, decisions filtered from
 * the event log by type=decision_made, linked PRs + commits + seeds,
 * and a structural timeline. Clean readable layout suitable as a
 * standalone reference page.
 */
export function PlotSummaryPage() {
	const { id } = useParams<{ id: string }>();
	const plotId = id ?? "";

	const query = useQuery({
		queryKey: ["plot-summary", plotId],
		queryFn: ({ signal }) => plotsApi.summary(plotId, signal),
		enabled: plotId.length > 0,
		// Summary view is institutional memory — refetch less aggressively
		// than the live PlotDetail page (which polls at 5s). 30s keeps
		// the view fresh enough for an open tab without hammering the
		// reader stack.
		staleTime: 30_000,
		refetchInterval: 30_000,
	});

	if (query.isLoading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading summary…</div>;
	}
	if (query.isError) {
		return (
			<div className="p-6 text-sm text-destructive">
				Failed to load summary: {(query.error as Error).message}
			</div>
		);
	}
	const a = query.data;
	if (a === undefined) return null;

	return (
		<div className="mx-auto max-w-4xl space-y-6 p-6">
			<Header artifact={a} />
			<IntentSection artifact={a} />
			<DecisionsSection decisions={a.decisions} />
			<LinkedPrsSection prs={a.linked_prs} />
			<LinkedCommitsSection commits={a.linked_commits} />
			<LinkedSeedsSection seeds={a.linked_seeds} />
			<TimelineSection timeline={a.timeline} />
		</div>
	);
}

function Header({ artifact }: { artifact: PlotSummaryArtifact }) {
	return (
		<header className="space-y-2 border-b pb-4">
			<div className="flex items-baseline gap-3">
				<h1 className="text-2xl font-semibold tracking-tight">{artifact.name}</h1>
				<PlotStatusBadge status={artifact.status} />
				<span className="ml-auto text-xs text-muted-foreground">{artifact.id}</span>
			</div>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
				<div>
					<dt className="inline font-medium">Created: </dt>
					<dd className="inline">{formatTimestamp(artifact.created_at) || "—"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Last activity: </dt>
					<dd className="inline">{formatTimestamp(artifact.last_event_at) || "—"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Done: </dt>
					<dd className="inline">
						{artifact.done_at !== null ? formatTimestamp(artifact.done_at) : "—"}
					</dd>
				</div>
			</dl>
			<div className="pt-2">
				<Link to={`/plots/${encodeURIComponent(artifact.id)}`}>
					<Button variant="outline" size="sm">
						← Back to live Plot
					</Button>
				</Link>
			</div>
		</header>
	);
}

function IntentSection({ artifact }: { artifact: PlotSummaryArtifact }) {
	const { intent } = artifact;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Intent</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4 text-sm leading-relaxed">
				<div>
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Goal
					</div>
					<p className="whitespace-pre-wrap">
						{intent.goal.trim().length > 0 ? intent.goal : <em>not set</em>}
					</p>
				</div>
				<StringListBlock label="Non-goals" items={intent.non_goals} />
				<StringListBlock label="Constraints" items={intent.constraints} />
				<StringListBlock label="Success criteria" items={intent.success_criteria} />
			</CardContent>
		</Card>
	);
}

function StringListBlock({ label, items }: { label: string; items: string[] }) {
	return (
		<div>
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			{items.length === 0 ? (
				<p className="text-muted-foreground">
					<em>none</em>
				</p>
			) : (
				<ul className="list-disc space-y-1 pl-5">
					{items.map((item, i) => (
						// eslint-disable-next-line react/no-array-index-key
						<li key={`${label}-${i}`} className="whitespace-pre-wrap">
							{item}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function DecisionsSection({ decisions }: { decisions: PlotSummaryDecision[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Decisions ({decisions.length})</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				{decisions.length === 0 ? (
					<p className="text-muted-foreground">No decisions recorded yet.</p>
				) : (
					<ul className="space-y-3">
						{decisions.map((d) => (
							<li key={`${d.at}-${d.actor}`} className="border-l-2 border-muted pl-3">
								<div className="font-medium">{d.summary}</div>
								{d.rationale !== undefined && d.rationale.length > 0 && (
									<div className="mt-1 text-muted-foreground">{d.rationale}</div>
								)}
								<div className="mt-1 text-xs text-muted-foreground">
									{formatTimestamp(d.at)} · {d.actor}
								</div>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function LinkedPrsSection({ prs }: { prs: PlotSummaryLinkedPr[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Linked PRs ({prs.length})</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				{prs.length === 0 ? (
					<p className="text-muted-foreground">No PRs linked.</p>
				) : (
					<ul className="space-y-2">
						{prs.map((pr) => (
							<li key={pr.attachment_id} className="flex items-baseline justify-between gap-3">
								<div>
									<span className="font-mono">{pr.ref}</span>
									<span className="ml-2 text-xs text-muted-foreground">({pr.role})</span>
								</div>
								<div className="text-xs text-muted-foreground">
									{pr.merged_at !== null ? (
										<span className="font-medium text-emerald-600 dark:text-emerald-400">
											merged {formatTimestamp(pr.merged_at)}
										</span>
									) : (
										<span>open · added {formatTimestamp(pr.added_at)}</span>
									)}
								</div>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function LinkedCommitsSection({ commits }: { commits: PlotSummaryLinkedCommit[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Linked commits ({commits.length})</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				{commits.length === 0 ? (
					<p className="text-muted-foreground">No commits recorded.</p>
				) : (
					<ul className="space-y-1">
						{commits.map((c) => (
							<li key={`${c.at}-${c.ref}`} className="flex items-baseline justify-between gap-3">
								<span className="font-mono text-xs">{c.ref}</span>
								<span className="text-xs text-muted-foreground">
									{formatTimestamp(c.at)} · {c.actor}
								</span>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function LinkedSeedsSection({ seeds }: { seeds: PlotSummaryLinkedSeed[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Linked seeds ({seeds.length})</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				{seeds.length === 0 ? (
					<p className="text-muted-foreground">No seeds linked.</p>
				) : (
					<ul className="space-y-1">
						{seeds.map((s) => (
							<li key={s.attachment_id} className="flex items-baseline justify-between gap-3">
								<div>
									<span className="font-mono">{s.ref}</span>
									<span className="ml-2 text-xs text-muted-foreground">({s.role})</span>
								</div>
								<span className="text-xs text-muted-foreground">
									added {formatTimestamp(s.added_at)} · {s.added_by}
								</span>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function TimelineSection({ timeline }: { timeline: PlotSummaryTimelineEntry[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Timeline ({timeline.length})</CardTitle>
			</CardHeader>
			<CardContent className="text-sm">
				{timeline.length === 0 ? (
					<p className="text-muted-foreground">No structural events yet.</p>
				) : (
					<ol className="space-y-2">
						{timeline.map((t) => (
							<li
								key={`${t.at}-${t.kind}`}
								className="flex items-baseline gap-3 border-l-2 border-muted pl-3"
							>
								<span className="w-32 shrink-0 text-xs text-muted-foreground">
									{formatTimestamp(t.at)}
								</span>
								<span className="flex-1">{t.label}</span>
								<span className="text-xs text-muted-foreground">{t.actor}</span>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
