import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { conversationsApi, projectsApi } from "@/api/client.ts";
import {
	CONVERSATION_STATES,
	type ConversationRow,
	type ConversationState,
} from "@/api/types.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { relativeTime } from "@/lib/utils.ts";

type StatusFilter = "all" | ConversationState;

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
	{ label: "All", value: "all" },
	...CONVERSATION_STATES.map((s) => ({
		label: s.charAt(0).toUpperCase() + s.slice(1),
		value: s,
	})),
];

/**
 * /leveret — cross-project overseer home (LEVERET.md §0.9, warren-763f).
 *
 * Lists leveret conversations (active / closed) most-recent-activity
 * first, backed by `GET /conversations`. The status filter chips drive
 * the server `?status=` query so the list query stays the single source
 * of truth for what's visible. Each row links to the conversation
 * split-view (warren-01c8, route stubbed at `/leveret/:id`).
 */
export function LeveretPage() {
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

	const conversations = useQuery({
		queryKey: ["conversations", statusFilter],
		queryFn: ({ signal }) =>
			conversationsApi.list(
				statusFilter === "all" ? {} : { status: statusFilter },
				signal,
			),
		refetchInterval: 5000,
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

	const rows = conversations.data?.conversations ?? [];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Leveret"
				description="Cross-project overseer — long-lived conversations that shape Plot intent before a plan run."
			/>

			<div className="flex flex-wrap items-center gap-2">
				{STATUS_FILTERS.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setStatusFilter(f.value)}
						className={`rounded-full border px-3 py-1 text-xs transition-colors ${
							statusFilter === f.value
								? "bg-(--color-primary) text-(--color-primary-foreground)"
								: "bg-(--color-card) hover:bg-(--color-accent)"
						}`}
					>
						{f.label}
					</button>
				))}
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{rows.length} conversations</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{conversations.isLoading ? (
						<p className="p-6 text-sm text-(--color-muted-foreground)">Loading…</p>
					) : conversations.isError ? (
						<p className="p-6 text-sm text-(--color-destructive)">
							{conversations.error instanceof Error
								? conversations.error.message
								: String(conversations.error)}
						</p>
					) : rows.length === 0 ? (
						<EmptyState statusFiltered={statusFilter !== "all"} />
					) : (
						<ConversationsTable
							conversations={rows}
							projectLabel={(id) => (id ? (projectIndex.get(id) ?? id) : "—")}
						/>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function EmptyState({ statusFiltered }: { statusFiltered: boolean }) {
	return (
		<p className="p-6 text-sm text-(--color-muted-foreground)">
			{statusFiltered
				? "No conversations match this status filter."
				: "No conversations yet. Start one from a Plot to shape its intent with the leveret overseer."}
		</p>
	);
}

function ConversationsTable({
	conversations,
	projectLabel,
}: {
	conversations: ConversationRow[];
	projectLabel: (projectId: string | null) => string;
}) {
	return (
		<div className="relative w-full overflow-auto">
			<table className="w-full caption-bottom text-sm">
				<thead className="border-b">
					<tr className="text-left text-(--color-muted-foreground)">
						<th className="h-10 whitespace-nowrap px-4 font-medium">Title</th>
						<th className="h-10 whitespace-nowrap px-4 font-medium">Status</th>
						<th className="h-10 whitespace-nowrap px-4 font-medium">Plot</th>
						<th className="h-10 whitespace-nowrap px-4 font-medium">Project</th>
						<th className="h-10 whitespace-nowrap px-4 font-medium">Last activity</th>
					</tr>
				</thead>
				<tbody>
					{conversations.map((c) => (
						<tr key={c.id} className="border-b last:border-0">
							<td className="whitespace-nowrap px-4 py-2">
								<Link
									to={`/leveret/${encodeURIComponent(c.id)}`}
									className="font-medium underline-offset-2 hover:underline"
								>
									{c.title || "Untitled conversation"}
								</Link>
								<div className="font-mono text-xs text-(--color-muted-foreground)">
									{c.id}
								</div>
							</td>
							<td className="whitespace-nowrap px-4 py-2">
								<span className="rounded-full border px-2 py-0.5 text-xs">
									{c.status}
								</span>
							</td>
							<td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
								{c.plotId ? (
									<Link
										to={`/plots/${encodeURIComponent(c.plotId)}`}
										className="underline-offset-2 hover:underline"
									>
										{c.plotId}
									</Link>
								) : (
									"—"
								)}
							</td>
							<td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
								{projectLabel(c.projectId)}
							</td>
							<td className="whitespace-nowrap px-4 py-2 text-(--color-muted-foreground)">
								{relativeTime(c.lastActivityAt)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
