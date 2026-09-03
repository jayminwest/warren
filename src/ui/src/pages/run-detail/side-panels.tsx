import { useState } from "react";
import type { RunRow } from "@/api/types.ts";
import { CostBasisNote } from "@/components/cost-basis-note.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { formatCostUsd, formatTokens } from "@/pages/run-detail-format.ts";
import { shortSha } from "@/pages/runs/runs-format.ts";
import { formatRunElapsed } from "./run-detail-format.ts";

/**
 * The Direction C run-detail side column's fact cards (warren-8c85 /
 * pl-7e38 step 4), translated from docs/ui-revamp/screens/run-detail.jsx:
 * Runtime, Spend, and Run definition panels as label/value grids, plus
 * the Prompt card with a Copy action. All values bind the real run row
 * — absent facts render "—", never a fabricated figure.
 */

function PanelShell({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="flex shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[39px] shrink-0 items-center border-b border-(--color-border) px-3">
				<h2 className="text-[11px] leading-[14px] font-semibold text-(--color-text)">{title}</h2>
				{trailing !== undefined ? <span className="flex-1" /> : null}
				{trailing}
			</header>
			<div className="flex flex-col gap-2 p-3">{children}</div>
		</section>
	);
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
	// Mobile (warren-ecd8): 82px label + 10px values below md — at 375px the
	// desktop 104px label leaves ~207px for values like anthropic/claude-sonnet-4-6.
	return (
		<div className="flex gap-2.5">
			<span className="w-[82px] shrink-0 text-[10px] leading-3 text-(--color-text-3) md:w-[104px]">
				{label}
			</span>
			<span className="min-w-0 flex-1 font-mono text-[10px] leading-3 break-words text-(--color-text-2) md:text-[9px]">
				{children}
			</span>
		</div>
	);
}

const DASH = <span className="text-(--color-text-3)">—</span>;

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

export function RuntimePanel({ run }: { run: RunRow }) {
	const handle = run.sandboxRunId ?? run.sandboxId ?? null;
	const workspaceBranch = run.branch ?? run.targetBranch ?? run.ref;
	const showTarget = run.targetBranch !== null && run.targetBranch !== workspaceBranch;
	return (
		<PanelShell
			title="Runtime"
			trailing={
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{relativeTime(run.endedAt ?? run.startedAt)}
				</span>
			}
		>
			<MetaRow label="provider">{run.provider ?? DASH}</MetaRow>
			<MetaRow label="sandbox">
				{handle !== null && handle.length > 0
					? handle
					: run.state === "queued"
						? "not scheduled"
						: DASH}
			</MetaRow>
			<MetaRow label="base commit">
				{run.baseSha !== null ? (
					shortSha(run.baseSha)
				) : run.baseCommit !== null ? (
					// warren-b19e: the pin is a fallback — the dispatch-time cut
					// point, not the resolved base the diff was measured against.
					<span>
						{shortSha(run.baseCommit)} <span className="text-(--color-text-3)">base pin</span>
					</span>
				) : (
					DASH
				)}
			</MetaRow>
			<MetaRow label="branch">{workspaceBranch ?? DASH}</MetaRow>
			{showTarget ? <MetaRow label="target">{run.targetBranch}</MetaRow> : null}
		</PanelShell>
	);
}

export function SpendPanel({ run }: { run: RunRow }) {
	// warren-b19e: the detail GET overlays the dispatch-context spend cap
	// (operator-only), so the "$X of $Y cap" denominator is real when the
	// run carries a cap — and unrenderable when it does not (warren-8c85, no
	// fabricated numbers). No MEASURED chip: the CostBasisNote beside the
	// figure already qualifies.
	const cap = run.maxCostUsd ?? null;
	return (
		<PanelShell title="Spend">
			<div className="flex items-baseline justify-between gap-2">
				<span className="font-mono text-[16px] leading-5 font-semibold tracking-[-0.04em] text-(--color-text) md:text-[22px] md:leading-7 md:font-medium">
					{run.costUsd !== null
						? run.costBasis === "subscription_estimate"
							? `~${formatCostUsd(run.costUsd)} est.`
							: formatCostUsd(run.costUsd)
						: DASH}
				</span>
				{cap !== null ? (
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						of {formatCostUsd(cap)} cap
					</span>
				) : null}
				<CostBasisNote run={run} />
			</div>
			{/*
			 * Mobile (warren-ecd8): the mock's inline "N% OF CAP · x TOKENS" line.
			 * The "% OF CAP" arm renders only when the detail GET overlay supplied
			 * a dispatch-time cap (warren-b19e); without one it stays out — warren
			 * never fabricates numbers — so only the measured total token count
			 * renders. The four token MetaRows stay (deliberate divergence from
			 * the mock, which drops them).
			 */}
			{cap !== null && totalTokens(run) !== null ? (
				<p className="font-mono text-[10px] leading-3 text-(--color-text-3) md:hidden">
					{Math.round(((run.costUsd ?? 0) / cap) * 100)}% OF CAP ·{" "}
					{formatTokens(totalTokens(run) ?? 0)} TOKENS
				</p>
			) : null}
			<MetaRow label="tokens in">
				{run.tokensInput !== null ? formatTokens(run.tokensInput) : DASH}
			</MetaRow>
			<MetaRow label="tokens out">
				{run.tokensOutput !== null ? formatTokens(run.tokensOutput) : DASH}
			</MetaRow>
			<MetaRow label="cache read">
				{run.tokensCacheRead !== null ? formatTokens(run.tokensCacheRead) : DASH}
			</MetaRow>
			<MetaRow label="cache write">
				{run.tokensCacheWrite !== null ? formatTokens(run.tokensCacheWrite) : DASH}
			</MetaRow>
		</PanelShell>
	);
}

export function RunDefinitionPanel({ run, projectName }: { run: RunRow; projectName: string }) {
	return (
		<PanelShell title="Run definition">
			<MetaRow label="agent">{run.agentName}</MetaRow>
			<MetaRow label="provider">{run.provider ?? DASH}</MetaRow>
			<MetaRow label="model">{run.model ?? DASH}</MetaRow>
			<MetaRow label="project">{projectName}</MetaRow>
			<MetaRow label="trigger">{run.trigger}</MetaRow>
			<MetaRow label="tracker">{run.seedId ?? "no tracker item"}</MetaRow>
			<MetaRow label="started">{formatTimestamp(run.startedAt)}</MetaRow>
			<MetaRow label="elapsed">{formatRunElapsed(run, Date.now())}</MetaRow>
			{run.parentRunId !== null ? (
				<MetaRow label={run.cloneKind === "replicate" ? "re-run of" : "continued from"}>
					{run.parentRunId}
				</MetaRow>
			) : null}
			{run.retryOf !== null ? <MetaRow label="retry of">{run.retryOf}</MetaRow> : null}
		</PanelShell>
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
		<PanelShell
			title="Prompt"
			trailing={
				<button
					type="button"
					onClick={copy}
					className="text-[10px] leading-3 font-medium text-(--color-text-2) hover:text-(--color-text)"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			}
		>
			<p className="max-h-[240px] overflow-auto font-mono text-[10px] leading-4 break-words text-(--color-text-2)">
				{run.prompt}
			</p>
		</PanelShell>
	);
}
