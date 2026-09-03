import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { cn, relativeTime } from "../../lib/utils.ts";
import {
	branchLabelOf,
	formatDuration,
	projectLabel,
	runCostLabel,
	shortSha,
	startedAtOf,
	truncateRuntimeHandle,
} from "./runs-format.ts";

/**
 * The Direction C workload-inventory table (warren-9e87 / pl-7e38
 * step 3), translated from docs/ui-revamp/screens/runs.jsx: dense mono
 * rows, no summary cards, token-variable colors only (dark/light swap
 * is automatic). Row click navigates to run detail; the run-id link
 * stays the keyboard-accessible path.
 */

/** State → token color. Running is information-blue, queued warning. */
function stateColor(state: RunRow["state"]): string {
	switch (state) {
		case "running":
			return "text-(--color-info)";
		case "queued":
			return "text-(--color-warning)";
		case "succeeded":
			return "text-(--color-success)";
		case "failed":
			return "text-(--color-danger)";
		default:
			return "text-(--color-text-3)";
	}
}

function stateDotColor(state: RunRow["state"]): string {
	switch (state) {
		case "running":
			return "bg-(--color-info)";
		case "queued":
			return "bg-(--color-warning)";
		case "succeeded":
			return "bg-(--color-success)";
		case "failed":
			return "bg-(--color-danger)";
		default:
			return "bg-(--color-text-3)";
	}
}

/** RUN column sub-line: seed back-link, continuation chain, or nothing. */
function RunSubLine({ row }: { row: RunRow }) {
	if (row.parentRunId !== null) {
		return (
			<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
				↪ from {row.parentRunId}
			</span>
		);
	}
	if (row.retryOf !== null) {
		return (
			<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
				retry of {row.retryOf}
			</span>
		);
	}
	if (row.seedId !== null) {
		return (
			<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
				{row.seedId}
			</span>
		);
	}
	return (
		<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">no tracker item</span>
	);
}

/**
 * Runtime column (warren-a0f4): line one is the backend kind
 * (`local` / `docker` / `k8s`) frozen at dispatch; line two is the real
 * per-run handle the server serves — `sandboxRunId` / `sandboxId` (the
 * pod name under k8s) — truncated to ~10 chars with the full value in
 * `title` and a click-to-copy that does not fire the row link. Rows with
 * neither fact keep the quiet "—" / "not scheduled".
 */
function RuntimeCell({ row }: { row: RunRow }) {
	const kind = row.runtimeBackend ?? null;
	const handle = row.sandboxRunId ?? row.sandboxId ?? null;
	const hasHandle = handle !== null && handle !== undefined && handle.length > 0;
	if (kind === null) {
		const sub = hasHandle ? (handle as string) : row.state === "queued" ? "not scheduled" : "—";
		return (
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate font-mono text-[10px] leading-3 text-(--color-text-2)">
					{sub}
				</span>
			</span>
		);
	}
	return (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span className="font-mono text-[10px] leading-3 text-(--color-text-2)">{kind}</span>
			{hasHandle ? <CopyHandle handle={handle as string} /> : null}
		</span>
	);
}

/** Second line of the runtime cell: the full handle on hover, click copies it. */
function CopyHandle({ handle }: { handle: string }) {
	const [copied, setCopied] = useState(false);
	const short = truncateRuntimeHandle(handle);
	return (
		<button
			type="button"
			title={handle}
			aria-label={`Copy runtime handle ${handle}`}
			onClick={(e) => {
				e.stopPropagation();
				void navigator.clipboard?.writeText(handle).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
			className="max-w-full cursor-pointer truncate text-left font-mono text-[9px] leading-3 text-(--color-text-3) hover:text-(--color-text-2)"
		>
			{copied ? "copied" : short}
		</button>
	);
}

/** PROJECT column sub-line: branch · base commit, "—" when neither set. */
function ProjectSubLine({ row }: { row: RunRow }) {
	const branch = branchLabelOf(row);
	const sha = shortSha(row.baseCommit);
	const label =
		branch !== null && sha !== "" ? `${branch} · ${sha}` : (branch ?? (sha !== "" ? sha : "—"));
	return (
		<span
			title={branch ?? undefined}
			className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)"
		>
			{label}
		</span>
	);
}

/** DELIVERY column: PR link when reap opened one, else the commit count. */
function DeliveryCell({ row }: { row: RunRow }) {
	if (row.prUrl !== null) {
		return (
			<a
				href={row.prUrl}
				target="_blank"
				rel="noreferrer"
				className="inline-flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-text-2) hover:text-(--color-text)"
			>
				PR
			</a>
		);
	}
	if (row.commitsAhead !== null) {
		return (
			<span className="inline-flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5 font-mono text-[9px] leading-3 text-(--color-text-2)">
				{row.commitsAhead} {row.commitsAhead === 1 ? "commit" : "commits"}
			</span>
		);
	}
	return <span className="font-mono text-[10px] leading-3 text-(--color-text-3)">—</span>;
}

function RunsTableRow({
	row,
	projectName,
	now,
	isOperator,
}: {
	row: RunRow;
	projectName: string;
	now: number;
	isOperator: boolean;
}) {
	const navigate = useNavigate();
	const runPath = `/runs/${encodeURIComponent(row.id)}`;
	return (
		<tr
			className="cursor-pointer border-b border-(--color-border) last:border-b-0 hover:bg-(--color-surface-hover)"
			onClick={() => navigate(runPath)}
		>
			<td className="w-[78px] px-2.5 py-1.5 align-middle">
				<span className="flex items-center gap-[7px]">
					<span
						className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stateDotColor(row.state))}
						aria-hidden
					/>
					<span className={cn("font-mono text-[10px] leading-3", stateColor(row.state))}>
						{row.state}
					</span>
				</span>
			</td>
			<td className="w-[128px] px-2.5 py-1.5 align-middle">
				<span className="flex min-w-0 flex-col gap-0.5">
					<a
						href={`#${runPath}`}
						onClick={(e) => e.stopPropagation()}
						className="truncate font-mono text-[10px] leading-3 text-(--color-text) hover:underline"
					>
						{row.id}
					</a>
					<RunSubLine row={row} />
				</span>
			</td>
			<td className="w-[118px] px-2.5 py-1.5 align-middle">
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate text-[11px] leading-[14px] text-(--color-text-2)">
						{row.agentName}
					</span>
					<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
						{row.model ?? "—"}
					</span>
				</span>
			</td>
			<td className="w-[128px] px-2.5 py-1.5 align-middle">
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate text-[11px] leading-[14px] text-(--color-text-2)">
						{projectName}
					</span>
					<ProjectSubLine row={row} />
				</span>
			</td>
			{isOperator ? (
				<td className="w-[88px] px-2.5 py-1.5 align-middle">
					<RuntimeCell row={row} />
				</td>
			) : null}
			<td className="w-[62px] px-2.5 py-1.5 align-middle font-mono text-[10px] leading-3 text-(--color-text-3)">
				{row.trigger}
			</td>
			<td className="w-[56px] px-2.5 py-1.5 align-middle font-mono text-[10px] leading-3 text-(--color-text-3)">
				{relativeTime(startedAtOf(row))}
			</td>
			<td className="w-[54px] px-2.5 py-1.5 text-right align-middle font-mono text-[10px] leading-3 text-(--color-text-2)">
				{formatDuration(row, now)}
			</td>
			<td className="w-[54px] px-2.5 py-1.5 text-right align-middle font-mono text-[10px] leading-3 text-(--color-text-2)">
				{runCostLabel(row)}
			</td>
			<td className="px-2.5 py-1.5 align-middle">
				<DeliveryCell row={row} />
			</td>
		</tr>
	);
}

function Th({
	children,
	className,
	width,
}: {
	children: string;
	className?: string;
	width?: string;
}) {
	return (
		<th
			scope="col"
			style={width ? { width } : undefined}
			className={cn(
				"px-2.5 text-left text-[9px] font-semibold tracking-[0.05em] text-(--color-text-3) uppercase",
				className,
			)}
		>
			{children}
		</th>
	);
}

/** Column order/widths mirror the runs.jsx export exactly. */
export function RunsTable({
	rows,
	projectIndex,
	now,
	isOperator,
}: {
	rows: readonly RunRow[];
	projectIndex: Map<string, string>;
	now: number;
	isOperator: boolean;
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[880px] border-collapse">
				<thead>
					<tr className="h-[31px] bg-(--color-thead)">
						<Th width="78px">State</Th>
						<Th width="128px">Run</Th>
						<Th width="118px">Agent</Th>
						<Th width="128px">Project</Th>
						{isOperator ? <Th width="88px">Runtime</Th> : null}
						<Th width="62px">Trigger</Th>
						<Th width="56px">Started</Th>
						<Th width="54px" className="text-right">
							Duration
						</Th>
						<Th width="54px" className="text-right">
							Cost
						</Th>
						<Th>Delivery</Th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<RunsTableRow
							key={row.id}
							now={now}
							row={row}
							projectName={
								row.projectId === null
									? "deleted project"
									: projectLabel(projectIndex.get(row.projectId), row.projectId)
							}
							isOperator={isOperator}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}
