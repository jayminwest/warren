import { GitBranch, RotateCcw, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ReapCompletedPayload, RunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PrChip, StatusBadge } from "@/components/ui/status.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { formatPullRequestLifecycle } from "@/lib/labels.ts";
import { relativeTime } from "@/lib/utils.ts";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { formatRunElapsed, formatTrigger } from "./run-detail-format.ts";
import { CancelRunButton } from "./steering-panel.tsx";

/**
 * Run detail header (warren-7d17): the run id and its operator actions,
 * then one line of status and outcome — status first (a failed run reads
 * its reason), then the PR, the branch, and the commits it shipped — then
 * a quiet line saying who asked for it, what it cost, and how long it
 * has taken. Elapsed and "started" tick with the page's `now`.
 */

function DispatchFromRunButtons({ run }: { run: RunRow }) {
	const navigate = useNavigate();
	const base = {
		agent: run.agentName,
		project: run.projectId ?? undefined,
		prompt: run.prompt,
	} as const;
	return (
		<>
			<Button
				variant="outline"
				onClick={() =>
					navigate("/dispatch", {
						state: { cloneFromRunId: run.id, ...base } satisfies DispatchRouteState,
					})
				}
			>
				<RotateCcw aria-hidden />
				Re-run from scratch
			</Button>
			<Button
				variant="outline"
				onClick={() =>
					navigate("/dispatch", {
						state: { continueFromRunId: run.id, ...base } satisfies DispatchRouteState,
					})
				}
			>
				<SquarePen aria-hidden />
				Continue with follow-up
			</Button>
		</>
	);
}

function PrStatus({ run }: { run: RunRow }) {
	if (run.prUrl !== null) return <PrChip url={run.prUrl} lifecycle={run.prState} />;
	if (run.prState === null) return null;
	return <StatusBadge state={run.prState} label={formatPullRequestLifecycle(run.prState)} />;
}

function DiffStat({ run }: { run: RunRow }) {
	if (run.insertions === null || run.deletions === null) return null;
	const files = run.filesChanged;
	return (
		<span className="text-xs tabular-nums">
			<span className="text-(--color-success)">+{run.insertions}</span>{" "}
			<span className="text-(--color-danger)">−{run.deletions}</span>
			{files !== null ? (
				<span className="text-(--color-text-3)">
					{" "}
					in {files} file{files === 1 ? "" : "s"}
				</span>
			) : null}
		</span>
	);
}

function Outcome({ run, reap }: { run: RunRow; reap: ReapCompletedPayload | null }) {
	const emptyPush = reap !== null && reap.branchPushed === true && reap.commitsAhead === 0;
	const commits = run.commitsAhead ?? 0;
	const branch = run.branch ?? run.targetBranch;
	return (
		<>
			<PrStatus run={run} />
			{branch !== null ? (
				<Tag className="max-w-full font-mono" title="Workspace branch">
					<GitBranch aria-hidden className="size-3 shrink-0" />
					<span className="truncate">{branch}</span>
				</Tag>
			) : null}
			{commits > 0 ? (
				<Tag className="tabular-nums">
					{commits} commit{commits === 1 ? "" : "s"}
				</Tag>
			) : null}
			<DiffStat run={run} />
			{emptyPush ? (
				<Tag title="The push succeeded but the branch has no new commits: the agent did not commit">
					Empty push
				</Tag>
			) : null}
		</>
	);
}

function Dot() {
	return (
		<span aria-hidden className="text-(--color-text-3)">
			·
		</span>
	);
}

function MetaLine({ run, projectName, now }: { run: RunRow; projectName: string; now: number }) {
	const live = run.endedAt === null;
	const parts: [string, ReactNode][] = [
		[
			"agent",
			<span key="agent">
				<span className="text-(--color-text)">{run.agentName}</span> on {projectName}
			</span>,
		],
		[
			"trigger",
			<span key="trigger">
				{formatTrigger(run.trigger)}
				{run.seedId !== null ? (
					<>
						{" "}
						for <span className="font-mono text-(--color-text)">{run.seedId}</span>
					</>
				) : null}
			</span>,
		],
	];
	if (run.model !== null) parts.push(["model", <span key="model">{run.model}</span>]);
	if (run.costUsd !== null) {
		parts.push([
			"cost",
			<span key="cost" className="tabular-nums">
				{run.costBasis === "subscription_estimate" ? "~" : ""}
				{formatCostUsd(run.costUsd)}
			</span>,
		]);
	}
	parts.push([
		"elapsed",
		<span key="elapsed" className="tabular-nums">
			{live ? "Running for " : "Took "}
			{formatRunElapsed(run, now)}
		</span>,
	]);
	const started =
		run.startedAt ?? (run.createdAt !== null ? new Date(run.createdAt).toISOString() : null);
	if (started !== null) {
		parts.push([
			"started",
			<span key="started" title={new Date(started).toLocaleString()}>
				started {relativeTime(started)}
			</span>,
		]);
	}
	return (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-(--color-text-2)">
			{parts.flatMap(([key, node], i) => (i === 0 ? [node] : [<Dot key={`dot-${key}`} />, node]))}
		</p>
	);
}

export function RunHeader({
	run,
	projectName,
	isTerminal,
	reap,
	now,
	onCancelSettled,
}: {
	run: RunRow;
	projectName: string;
	isTerminal: boolean;
	reap: ReapCompletedPayload | null;
	now: number;
	onCancelSettled: () => void;
}) {
	return (
		<header className="flex shrink-0 flex-col gap-2.5">
			<nav aria-label="Breadcrumb" className="text-xs text-(--color-text-3)">
				<Link to="/runs" className="hover:text-(--color-text)">
					Runs
				</Link>
				<span aria-hidden className="px-1.5">
					/
				</span>
				<span className="font-mono">{run.id}</span>
			</nav>
			<div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
				<div className="flex min-w-0 flex-col gap-2">
					<h1 className="truncate font-mono text-xl font-semibold tracking-tight text-(--color-text)">
						{run.id}
					</h1>
					<div className="flex flex-wrap items-center gap-2">
						<StatusBadge state={run.state} reason={run.failureReason} />
						<Outcome run={run} reap={reap} />
					</div>
				</div>
				<OperatorOnly>
					<div className="flex flex-wrap items-center gap-2">
						{isTerminal ? (
							<DispatchFromRunButtons run={run} />
						) : (
							<CancelRunButton runId={run.id} onSettled={onCancelSettled} />
						)}
					</div>
				</OperatorOnly>
			</div>
			<MetaLine run={run} projectName={projectName} now={now} />
		</header>
	);
}
