import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { agentsApi, projectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { IssueQueueEntry } from "../../../core/wire.ts";

export function ProjectIssuesPanel({ projectId }: { projectId: string }) {
	const [selected, setSelected] = useState<IssueQueueEntry | null>(null);
	const query = useQuery({
		queryKey: ["project-issues", projectId],
		queryFn: ({ signal }) => projectsApi.issues(projectId, signal),
		refetchInterval: 60000,
	});
	if (query.isLoading) return <Spinner label="Loading issue queue" />;
	if (query.isError)
		return (
			<Alert variant="danger" title="Issue queue unavailable">
				{formatError(query.error)}
			</Alert>
		);
	if (!query.data?.supported) return null;
	return (
		<section
			className="flex min-w-0 flex-col rounded-[4px] border border-(--color-border) bg-(--color-surface)"
			aria-label="Ready issues"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-border) px-3.5 py-3">
				<h2 className="text-[12px] font-semibold">Ready issues</h2>
				<Button
					size="sm"
					variant="outline"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					Refresh
				</Button>
			</div>
			<p className="px-3.5 py-2 text-xs text-(--color-text-3)">
				Matches the connected tracker’s filters. Opening this list does not start runs.
			</p>
			{query.data.issues.length === 0 && <p className="px-3.5 py-3 text-sm">No matching issues.</p>}
			<ul className="min-w-0 divide-y divide-(--color-border)">
				{query.data.issues.map((issue) => (
					<li
						key={issue.id}
						className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-3.5 py-3"
					>
						<div className="min-w-0 flex-1">
							<p className="break-words text-sm">{issue.title ?? issue.id}</p>
							<p className="break-all text-xs text-(--color-text-3)">{issue.id}</p>
						</div>
						{issue.runId ? (
							<Link className="text-xs underline" to={`/runs/${encodeURIComponent(issue.runId)}`}>
								View run · {issue.runState}
							</Link>
						) : (
							<OperatorOnly>
								<Button size="sm" onClick={() => setSelected(issue)}>
									Dispatch
								</Button>
							</OperatorOnly>
						)}
					</li>
				))}
			</ul>
			{selected && (
				<IssueDispatchDialog
					projectId={projectId}
					issue={selected}
					onClose={() => setSelected(null)}
				/>
			)}
		</section>
	);
}

function IssueDispatchDialog({
	projectId,
	issue,
	onClose,
}: {
	projectId: string;
	issue: IssueQueueEntry;
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const [agent, setAgent] = useState("");
	const [cap, setCap] = useState("3");
	const agents = useQuery({
		queryKey: ["agents", projectId],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});
	const dispatch = useMutation({
		mutationFn: () =>
			projectsApi.dispatchIssue(projectId, issue.id, { agent, maxCostUsd: Number(cap) }),
		onSuccess: ({ run }) => navigate(`/runs/${encodeURIComponent(run.id)}`),
	});
	const valid = agent.length > 0 && Number.isFinite(Number(cap)) && Number(cap) > 0;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !dispatch.isPending) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Dispatch issue</DialogTitle>
					<DialogDescription>{issue.title ?? issue.id}</DialogDescription>
				</DialogHeader>
				<p className="break-all text-xs">{issue.id}</p>
				<p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm">
					{issue.description || "No description provided."}
				</p>
				<label className="flex flex-col gap-1 text-sm">
					Agent
					<select
						className="min-w-0 rounded border border-(--color-border) bg-(--color-surface) p-2"
						value={agent}
						onChange={(e) => setAgent(e.target.value)}
					>
						<option value="">Select agent</option>
						{agents.data?.agents.map((a) => (
							<option key={a.name} value={a.name}>
								{a.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					Per-run cost cap (USD)
					<input
						className="min-w-0 rounded border border-(--color-border) bg-(--color-surface) p-2"
						type="number"
						min="0.01"
						step="0.01"
						value={cap}
						onChange={(e) => setCap(e.target.value)}
					/>
				</label>
				<p className="text-xs text-(--color-text-3)">
					Starts a paid agent run. Eligibility is checked again before execution. An existing issue
					run is reused; this does not merge or deploy changes.
				</p>
				{agents.isError && (
					<Alert variant="danger" title="Could not load agents">
						{formatError(agents.error)}
					</Alert>
				)}
				{dispatch.isError && (
					<Alert variant="danger" title="Dispatch failed">
						{formatError(dispatch.error)}
					</Alert>
				)}
				<DialogFooter>
					<Button variant="outline" disabled={dispatch.isPending} onClick={onClose}>
						Cancel
					</Button>
					<Button disabled={!valid || dispatch.isPending} onClick={() => dispatch.mutate()}>
						{dispatch.isPending ? "Dispatching…" : "Start run"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
