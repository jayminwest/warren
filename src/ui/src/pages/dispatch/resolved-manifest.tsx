import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import {
	type AdmissionRow,
	type AdmissionStatus,
	buildAdmissionRows,
	buildManifestLines,
	buildManifestSummaryLines,
	type ManifestLine,
} from "./manifest-view.ts";

/**
 * Right rail of the Direction C Dispatch page (warren-bbe8): the resolved
 * manifest and admission policy, translated from
 * `docs/ui-revamp/screens/dispatch.jsx`. Pure derivation lives in
 * `./manifest-view.ts` — this file only renders it.
 */

const keyClass = "font-mono text-[9px] leading-[15px] text-(--color-info)";
const valueClass = "font-mono text-[9px] leading-[15px] text-(--color-success)";
const summaryKeyClass = "font-mono text-[10px] leading-[14px] text-(--color-info)";
const summaryValueClass = "font-mono text-[10px] leading-[14px] text-(--color-success)";

const DOT_CLASS: Record<AdmissionStatus, string> = {
	ok: "bg-(--color-success)",
	absent: "bg-(--color-neutral)",
	unknown: "bg-(--color-neutral)",
};

function ManifestLineRow({
	line,
	summary = false,
}: {
	line: ManifestLine;
	/** Mobile summary arm (pl-4ab6): flat lines at the mock's 10px scale. */
	summary?: boolean;
}) {
	const keys = summary ? summaryKeyClass : keyClass;
	const values = summary ? summaryValueClass : valueClass;
	return (
		<div className={`flex min-w-0 ${line.indent && !summary ? "pl-[14px]" : ""}`}>
			<span className={`${keys} shrink-0`}>{line.key}</span>
			{line.value !== undefined ? (
				<>
					<span className={`${keys} shrink-0`}>&nbsp;</span>
					<span
						className={`${values} min-w-0 truncate`}
						{...(line.value ? { title: line.value } : {})}
					>
						{line.value}
					</span>
				</>
			) : null}
		</div>
	);
}

function AdmissionRowView({ row }: { row: AdmissionRow }) {
	return (
		<div
			className="flex min-h-[28px] items-center gap-2"
			{...(row.title ? { title: row.title } : {})}
		>
			<span className="w-[10px] shrink-0">
				<span className={`block h-1.5 w-1.5 rounded-full ${DOT_CLASS[row.status]}`} />
			</span>
			<span className="flex-1 text-[10px] leading-3 text-(--color-text-2)">{row.label}</span>
			<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">{row.value}</span>
		</div>
	);
}

/** One-line admission status band below md (pl-4ab6 / warren-5cf7). */
function AdmissionBand({ rows }: { rows: readonly AdmissionRow[] }) {
	const allOk = rows.length > 0 && rows.every((row) => row.status === "ok");
	const okCount = rows.filter((row) => row.status === "ok").length;
	return (
		<div className="flex items-center gap-2 py-[3px] md:hidden">
			<span
				className={`h-1.5 w-1.5 shrink-0 rounded-full ${
					allOk ? "bg-(--color-success)" : "bg-(--color-neutral)"
				}`}
			/>
			<span className="font-mono text-[10px] leading-[13px] text-(--color-text-2)">
				{allOk
					? "ADMISSION OK · policy checks pass"
					: `ADMISSION · policy checks pending (${okCount}/${rows.length})`}
			</span>
		</div>
	);
}

export interface ResolvedManifestProps {
	readonly project: ProjectRow | undefined;
	readonly ref: string;
	readonly seedId: string;
	readonly agent: string;
	readonly provider: string;
	readonly model: string;
	readonly costCap: string;
	/** Project's `.warren/config.yaml` `runBranchPrefix`, when declared. */
	readonly runBranchPrefix: string | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly valid: boolean;
}

export function ResolvedManifest(props: ResolvedManifestProps) {
	const lines = buildManifestLines({
		project: props.project,
		ref: props.ref,
		seedId: props.seedId,
		agent: props.agent,
		provider: props.provider,
		model: props.model,
		costCap: props.costCap,
		runBranchPrefix: props.runBranchPrefix,
		runtime: props.facts?.runtime,
	});
	const admission = buildAdmissionRows(props.project, props.facts);
	const summary = buildManifestSummaryLines({
		project: props.project,
		ref: props.ref,
		seedId: props.seedId,
		agent: props.agent,
		provider: props.provider,
		model: props.model,
		costCap: props.costCap,
		runBranchPrefix: props.runBranchPrefix,
		runtime: props.facts?.runtime,
	});

	return (
		<aside className="flex w-full shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-sidebar) md:bg-(--color-surface) lg:w-[350px]">
			<div className="flex h-[39px] shrink-0 items-center border-b border-(--color-border) px-3">
				<h2 className="text-[11px] font-semibold leading-[14px] text-(--color-text)">
					Resolved manifest
				</h2>
				<div className="flex-1" />
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3) md:hidden">
					READ-ONLY
				</span>
				<span
					className={
						props.valid
							? "hidden font-mono text-[9px] leading-3 text-(--color-success) md:block"
							: "hidden font-mono text-[9px] leading-3 text-(--color-text-3) md:block"
					}
				>
					{props.valid ? "VALID" : "INCOMPLETE"}
				</span>
			</div>
			<div className="hidden flex-col p-3 md:flex">
				{lines.map((line) => (
					<ManifestLineRow key={`${line.indent ? "i" : "r"}:${line.key}`} line={line} />
				))}
			</div>
			<div className="flex flex-col gap-[3px] p-3 md:hidden">
				{summary.map((line) => (
					<ManifestLineRow key={`s:${line.key}`} line={line} summary />
				))}
			</div>
			<div className="flex flex-col border-t border-(--color-border) px-3 py-2">
				<AdmissionBand rows={admission} />
				<div className="hidden flex-col md:flex">
					{admission.map((row) => (
						<AdmissionRowView key={row.label} row={row} />
					))}
				</div>
			</div>
		</aside>
	);
}
