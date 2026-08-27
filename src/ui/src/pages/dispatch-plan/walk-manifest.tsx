import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import type { AdmissionRow, AdmissionStatus, ManifestLine } from "../dispatch/manifest-view.ts";
import { buildAdmissionRows, repositoryLabel } from "../dispatch/manifest-view.ts";
import { parseCostCap, parseIssueIds, type WalkDraft } from "./walk-draft.ts";

/**
 * Right rail of the Direction C Dispatch plan page (warren-02bb): the
 * resolved walk manifest and admission policy, translated from
 * `docs/ui-revamp/screens/dispatch-plan.jsx`. Pure derivation lives in
 * `./walk-manifest-view.ts` — this file only renders it.
 */

const keyClass = "font-mono text-[9px] leading-[15px] text-(--color-info)";
const valueClass = "font-mono text-[9px] leading-[15px] text-(--color-success)";

const DOT_CLASS: Record<AdmissionStatus, string> = {
	ok: "bg-(--color-success)",
	absent: "bg-(--color-neutral)",
	unknown: "bg-(--color-neutral)",
};

export interface WalkManifestInput {
	readonly project: ProjectRow | undefined;
	readonly ref: string;
	readonly agent: string;
	readonly provider: string;
	readonly model: string;
	readonly costCap: string;
	readonly planId: string;
	readonly issuesText: string;
	readonly sourceMode: WalkDraft["sourceMode"];
	readonly runtime: InstanceFactsResponse["runtime"] | undefined;
}

/** The resolved walk manifest the right rail renders, in display order. */
export function buildWalkManifestLines(input: WalkManifestInput): readonly ManifestLine[] {
	const { project } = input;
	const ref = input.ref.trim().length > 0 ? input.ref.trim() : (project?.defaultBranch ?? "—");
	const repository = project ? (repositoryLabel(project.gitUrl) ?? "—") : "—";
	const issues = parseIssueIds(input.issuesText);
	const childrenValue =
		input.sourceMode === "issues"
			? `${issues.length} · explicit order`
			: input.planId.trim().length > 0
				? input.planId.trim()
				: "—";
	return [
		{ key: "apiVersion: ", value: "warren.plan-run/v1" },
		{ key: "kind: ", value: "PlanRun" },
		{ key: "metadata:" },
		{ indent: true, key: "project: ", value: project ? project.id : "—" },
		{
			indent: true,
			key: input.sourceMode === "issues" ? "issues: " : "plan: ",
			value: childrenValue,
		},
		{ key: "workspace:" },
		{ indent: true, key: "repository: ", value: repository },
		{ indent: true, key: "ref: ", value: ref },
		{ key: "runtime:" },
		{ indent: true, key: "adapter: ", value: input.agent.length > 0 ? input.agent : "—" },
		{ indent: true, key: "model: ", value: modelValue(input.provider, input.model) },
		{ key: "limits:" },
		{ indent: true, key: "costUsd: ", value: costValue(input.costCap) },
		{ key: "walk:" },
		{
			indent: true,
			key: "children: ",
			value:
				input.sourceMode === "issues"
					? `${issues.length} · explicit order`
					: openChildrenValue(input),
		},
		{ indent: true, key: "gate: ", value: "previous PR merged" },
		{ key: "delivery:" },
		{ indent: true, key: "pushBranch: ", value: "true" },
	];
}

function openChildrenValue(input: WalkManifestInput): string {
	if (input.planId.trim().length === 0) return "—";
	// The open-child count arrives with the ready-plans query; the rail
	// renders the plan id here and the Children section of the form
	// carries the count, so no fabricated numbers ride this line.
	return input.planId.trim();
}

function modelValue(provider: string, model: string): string {
	if (provider.length > 0 && model.length > 0) return `${provider}/${model}`;
	if (model.length > 0) return model;
	if (provider.length > 0) return provider;
	return "—";
}

function costValue(costCap: string): string {
	const parsed = parseCostCap(costCap);
	return parsed !== null && "value" in parsed ? `${parsed.value.toFixed(2)} / child` : "—";
}

/** The admission-policy rows the right rail renders, in display order. */
export function buildWalkAdmissionRows(
	project: ProjectRow | undefined,
	facts: InstanceFactsResponse | undefined,
): readonly AdmissionRow[] {
	const base = buildAdmissionRows(project, facts);
	// Plan runs require the seeds queue; surface the merge gate explicitly
	// (the canvas row) after the admission rows it composes with.
	return [
		...base,
		{
			label: "Merge gate",
			value: "PR MERGE REQUIRED",
			status: "ok" as const,
			title: "Each child gates on the previous child's PR merging",
		},
	];
}

function ManifestLineRow({ line }: { line: ManifestLine }) {
	return (
		<div className={`flex ${line.indent ? "pl-[14px]" : ""}`}>
			<span className={keyClass}>{line.key}</span>
			{line.value !== undefined ? (
				<>
					<span className={keyClass}>&nbsp;</span>
					<span className={valueClass}>{line.value}</span>
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

export interface WalkManifestProps {
	readonly input: WalkManifestInput;
	readonly project: ProjectRow | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly valid: boolean;
}

export function WalkManifest(props: WalkManifestProps) {
	const lines = buildWalkManifestLines(props.input);
	const admission = buildWalkAdmissionRows(props.project, props.facts);

	return (
		<aside className="flex w-full shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) lg:w-[350px]">
			<div className="flex h-[39px] shrink-0 items-center border-b border-(--color-border) px-3">
				<h2 className="text-[11px] font-semibold leading-[14px] text-(--color-text)">
					Resolved manifest
				</h2>
				<div className="flex-1" />
				<span
					className={
						props.valid
							? "font-mono text-[9px] leading-3 text-(--color-success)"
							: "font-mono text-[9px] leading-3 text-(--color-text-3)"
					}
				>
					{props.valid ? "VALID" : "INCOMPLETE"}
				</span>
			</div>
			<div className="flex flex-col p-3">
				{lines.map((line) => (
					<ManifestLineRow key={`${line.indent ? "i" : "r"}:${line.key}`} line={line} />
				))}
			</div>
			<div className="flex flex-col border-t border-(--color-border) px-3 py-2">
				{admission.map((row) => (
					<AdmissionRowView key={row.label} row={row} />
				))}
			</div>
		</aside>
	);
}
