import { Bot, FolderGit2, GitMerge, Layers, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import type { ManifestLine } from "../dispatch/manifest-view.ts";
import {
	buildAdmissionRows,
	costCapLabel,
	isolationLabel,
	modelLabel,
	modelValue,
	repositoryLabel,
} from "../dispatch/manifest-view.ts";
import { SummaryCard, type SummaryRow } from "../dispatch/summary-card.tsx";
import { parseCostCap, parseIssueIds, type WalkDraft } from "./walk-draft.ts";

/**
 * The Dispatch plan page's "What will happen" rail (warren-02bb, restyled
 * in warren-9474): the walk restated in operator words, plus the raw
 * manifest one click away. Derived from the same draft the form edits.
 */

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

function costValue(costCap: string): string {
	const parsed = parseCostCap(costCap);
	return parsed !== null && "value" in parsed ? `${parsed.value.toFixed(2)} / child` : "—";
}

function stepsRow(input: WalkManifestInput, openChildCount: number | null): SummaryRow {
	if (input.sourceMode === "issues") {
		const count = parseIssueIds(input.issuesText).length;
		return {
			icon: Layers,
			label: "Steps",
			value:
				count > 0
					? `${count} ${count === 1 ? "issue" : "issues"}, in the order listed`
					: "List the issues",
			note: "One run per issue",
		};
	}
	const planId = input.planId.trim();
	return {
		icon: Layers,
		label: "Steps",
		value: planId.length > 0 ? <span className="font-mono">{planId}</span> : "Pick a plan",
		note:
			openChildCount !== null && planId.length > 0
				? `${openChildCount} open ${openChildCount === 1 ? "step" : "steps"}, one run each`
				: "One run per open step",
	};
}

export function buildWalkSummaryRows(
	input: WalkManifestInput,
	openChildCount: number | null,
): SummaryRow[] {
	const { project } = input;
	const isolation = isolationLabel(input.runtime);
	const ref = input.ref.trim().length > 0 ? input.ref.trim() : project?.defaultBranch;
	const cap = costCapLabel(input.costCap);
	return [
		{
			icon: FolderGit2,
			label: "Workspace",
			value: project ? (repositoryLabel(project.gitUrl) ?? project.id) : "Pick a project",
			note: project
				? `A fresh clone of ${ref} per step${isolation === null ? "" : `, isolated in a ${isolation}`}`
				: undefined,
		},
		stepsRow(input, openChildCount),
		{
			icon: Bot,
			label: "Agent",
			value: input.agent.length > 0 ? input.agent : "Pick an agent",
			note: modelLabel(input.provider, input.model) ?? "The agent's default model",
		},
		{
			icon: Wallet,
			label: "Spend cap per step",
			value: cap ?? "None set here",
			note: cap
				? "A step's run stops when its spend crosses this"
				: "The agent's or project's cap applies, if one is set",
		},
		{
			icon: GitMerge,
			label: "Gate",
			value: "Previous pull request merged",
			note: "The next step starts only after the last one merges",
		},
	];
}

export interface WalkSummaryProps {
	readonly input: WalkManifestInput;
	readonly project: ProjectRow | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly openChildCount: number | null;
	readonly valid: boolean;
	readonly actions: ReactNode;
}

export function WalkSummary(props: WalkSummaryProps) {
	return (
		<SummaryCard
			rows={buildWalkSummaryRows(props.input, props.openChildCount)}
			checks={buildAdmissionRows(props.project, props.facts)}
			manifest={buildWalkManifestLines(props.input)}
			valid={props.valid}
			actions={props.actions}
		/>
	);
}
