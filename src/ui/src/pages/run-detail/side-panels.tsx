import { Check, Copy, LifeBuoy } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { CostBasisNote } from "@/components/cost-basis-note.tsx";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardBody, CardHeader } from "@/components/ui/card.tsx";
import { cn, formatTimestamp, relativeTime } from "@/lib/utils.ts";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import { formatCostUsd, formatTokens } from "@/pages/run-detail-format.ts";
import { shortSha } from "@/pages/runs/runs-format.ts";
import { formatTrigger, readRescueFacts } from "./run-detail-format.ts";

/**
 * The run-detail side column's fact cards (warren-8c85, migrated in
 * warren-9474): Runtime, Spend, Run definition, and Prompt. Every value
 * binds the real run row — an absent fact renders "—", never a
 * fabricated figure. Machine identifiers are mono; everything else sans.
 */

const DASH = <span className="text-(--color-text-3)">—</span>;

/** One label/value row. `mono` for machine identifiers only. */
export function Fact({
	label,
	mono,
	children,
}: {
	label: string;
	mono?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="flex gap-3 py-1">
			<dt className="w-28 shrink-0 text-sm text-(--color-text-3)">{label}</dt>
			<dd
				className={cn(
					"min-w-0 flex-1 break-words text-(--color-text-2)",
					mono ? "pt-px font-mono text-xs" : "text-sm",
				)}
			>
				{children}
			</dd>
		</div>
	);
}

export function FactCard({
	title,
	meta,
	actions,
	children,
}: {
	title: string;
	meta?: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Card className="self-stretch">
			<CardHeader title={title} meta={meta} actions={actions} />
			<CardBody className="py-2.5">
				<dl>{children}</dl>
			</CardBody>
		</Card>
	);
}

/** Total measured tokens across all four counters, or null if none is set. */
function totalTokens(run: RunRow): number | null {
	const parts = [
		run.tokensInput,
		run.tokensOutput,
		run.tokensCacheRead,
		run.tokensCacheWrite,
	].filter((v): v is number => v !== null);
	if (parts.length === 0) return null;
	return parts.reduce((a, b) => a + b, 0);
}

/**
 * #1241 (warren-1db0): the salvage rescue block on the Runtime card — the
 * rescue branch, the durable bundle path, the copy-ready re-dispatch
 * command, and (operators only) a button that opens Dispatch with the
 * run's `rescueFromRunId` filled in. Renders nothing for unsalvaged runs.
 */
function RescueRows({ run }: { run: RunRow }) {
	const navigate = useNavigate();
	const rescue = readRescueFacts(run);
	if (rescue === null) return null;
	return (
		<div className="mt-2 flex flex-col gap-1 border-t border-(--color-border) pt-2">
			<Fact label="Rescue" mono>
				{rescue.ref}
			</Fact>
			{rescue.bundlePath !== null ? (
				<Fact label="Rescue bundle" mono>
					{rescue.bundlePath}
				</Fact>
			) : null}
			<p className="py-1 font-mono text-xs break-words text-(--color-text-3)">{rescue.hint}</p>
			<OperatorOnly>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					onClick={() =>
						navigate("/dispatch", {
							state: {
								rescueFromRunId: run.id,
								agent: run.agentName,
								...(run.projectId !== null ? { project: run.projectId } : {}),
								prompt: run.prompt,
							} satisfies DispatchRouteState,
						})
					}
				>
					<LifeBuoy aria-hidden />
					Dispatch from rescue
				</Button>
			</OperatorOnly>
		</div>
	);
}

function BaseCommit({ run }: { run: RunRow }) {
	if (run.baseSha !== null) return <>{shortSha(run.baseSha)}</>;
	if (run.baseCommit === null) return DASH;
	// warren-b19e: the pin is a fallback — the dispatch-time cut point, not
	// the resolved base the diff was measured against.
	return (
		<span>
			{shortSha(run.baseCommit)} <span className="font-sans text-(--color-text-3)">base pin</span>
		</span>
	);
}

export function RuntimePanel({ run }: { run: RunRow }) {
	const handle = run.sandboxRunId ?? run.sandboxId ?? null;
	const hasHandle = handle !== null && handle.length > 0;
	const workspaceBranch = run.branch ?? run.targetBranch ?? run.ref;
	const showTarget = run.targetBranch !== null && run.targetBranch !== workspaceBranch;
	const when = run.endedAt ?? run.startedAt;
	const meta =
		when !== null ? `${run.endedAt !== null ? "Ended" : "Started"} ${relativeTime(when)}` : null;
	return (
		<FactCard title="Runtime" meta={meta}>
			<Fact label="Provider">{run.provider ?? DASH}</Fact>
			{run.runtimeBackend != null ? <Fact label="Backend">{run.runtimeBackend}</Fact> : null}
			<Fact label="Sandbox" mono={hasHandle}>
				{hasHandle ? handle : run.state === "queued" ? "Not scheduled yet" : DASH}
			</Fact>
			<Fact label="Base commit" mono>
				<BaseCommit run={run} />
			</Fact>
			<Fact label="Branch" mono={workspaceBranch !== null}>
				{workspaceBranch ?? DASH}
			</Fact>
			{showTarget ? (
				<Fact label="Target" mono>
					{run.targetBranch}
				</Fact>
			) : null}
			<RescueRows run={run} />
		</FactCard>
	);
}

function CapMeter({ spent, cap }: { spent: number; cap: number }) {
	const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
	const tone =
		pct >= 90 ? "bg-(--color-danger)" : pct >= 70 ? "bg-(--color-warning)" : "bg-(--color-success)";
	return (
		<div className="mt-2">
			<div className="h-1.5 overflow-hidden rounded-full bg-(--color-surface-hover)">
				<div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
			</div>
			<p className="mt-1 text-xs text-(--color-text-3) tabular-nums">{pct}% of cap</p>
		</div>
	);
}

function TokenStat({ label, value }: { label: string; value: number | null }) {
	return (
		<div className="flex flex-col">
			<span className="text-xs text-(--color-text-3)">{label}</span>
			<span className="text-sm text-(--color-text-2) tabular-nums">
				{value !== null ? formatTokens(value) : "—"}
			</span>
		</div>
	);
}

function costLabel(run: RunRow): React.ReactNode {
	if (run.costUsd === null) return DASH;
	const figure = formatCostUsd(run.costUsd);
	return run.costBasis === "subscription_estimate" ? `~${figure}` : figure;
}

export function SpendPanel({ run }: { run: RunRow }) {
	// warren-b19e: the detail GET overlays the dispatch-context spend cap
	// (operator-only), so the "$X of $Y cap" denominator is real when the
	// run carries a cap — and absent when it does not (no fabricated numbers).
	const cap = run.maxCostUsd ?? null;
	const tokens = totalTokens(run);
	return (
		<Card className="self-stretch">
			<CardHeader title="Spend" meta={tokens !== null ? `${formatTokens(tokens)} tokens` : null} />
			<CardBody className="flex flex-col gap-3">
				<div>
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="text-2xl font-semibold tracking-tight text-(--color-text) tabular-nums">
							{costLabel(run)}
						</span>
						{cap !== null ? (
							<span className="text-sm text-(--color-text-3) tabular-nums">
								of {formatCostUsd(cap)} cap
							</span>
						) : null}
						<CostBasisNote run={run} />
					</div>
					{cap !== null && run.costUsd !== null ? <CapMeter spent={run.costUsd} cap={cap} /> : null}
				</div>
				<div className="grid grid-cols-2 gap-x-4 gap-y-2">
					<TokenStat label="Input" value={run.tokensInput} />
					<TokenStat label="Output" value={run.tokensOutput} />
					<TokenStat label="Cache read" value={run.tokensCacheRead} />
					<TokenStat label="Cache write" value={run.tokensCacheWrite} />
				</div>
			</CardBody>
		</Card>
	);
}

function lineageLabel(run: RunRow): string {
	if (run.cloneKind === "replicate") return "Re-run of";
	if (run.cloneKind === "rescue") return "Rescued from";
	return "Continued from";
}

function RunLink({ id }: { id: string }) {
	return (
		<Link
			to={`/runs/${encodeURIComponent(id)}`}
			className="text-(--color-primary) underline-offset-2 hover:underline"
		>
			{id}
		</Link>
	);
}

export function RunDefinitionPanel({ run, projectName }: { run: RunRow; projectName: string }) {
	return (
		<FactCard title="Run definition">
			<Fact label="Agent">{run.agentName}</Fact>
			<Fact label="Model">{run.model ?? DASH}</Fact>
			<Fact label="Project">{projectName}</Fact>
			<Fact label="Trigger">{formatTrigger(run.trigger)}</Fact>
			<Fact label="Tracker item" mono={run.seedId !== null}>
				{run.seedId ?? "None"}
			</Fact>
			<Fact label="Started">{formatTimestamp(run.startedAt)}</Fact>
			{run.endedAt !== null ? <Fact label="Ended">{formatTimestamp(run.endedAt)}</Fact> : null}
			{run.parentRunId !== null ? (
				<Fact label={lineageLabel(run)} mono>
					<RunLink id={run.parentRunId} />
				</Fact>
			) : null}
			{run.retryOf !== null ? (
				<Fact label="Retry of" mono>
					<RunLink id={run.retryOf} />
				</Fact>
			) : null}
		</FactCard>
	);
}

export function PromptPanel({ run }: { run: RunRow }) {
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard.writeText(run.prompt).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		});
	};
	return (
		<Card className="self-stretch">
			<CardHeader
				title="Prompt"
				actions={
					<Button variant="ghost" size="sm" onClick={copy}>
						{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
						{copied ? "Copied" : "Copy"}
					</Button>
				}
			/>
			<CardBody>
				<p className="max-h-60 overflow-auto text-sm break-words whitespace-pre-wrap text-(--color-text-2)">
					{run.prompt}
				</p>
			</CardBody>
		</Card>
	);
}
