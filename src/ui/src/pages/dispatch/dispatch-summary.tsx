import { Bot, FolderGit2, GitBranch, Ticket, Timer, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import type { DispatchRouteState } from "./dispatch-draft.ts";
import {
	buildAdmissionRows,
	buildManifestLines,
	costCapLabel,
	isolationLabel,
	modelLabel,
	repositoryLabel,
	runBranchValue,
	timeLimitLabel,
} from "./manifest-view.ts";
import { SummaryCard, type SummaryRow } from "./summary-card.tsx";

/**
 * The Dispatch page's "What will happen" rail (warren-bbe8, restyled in
 * warren-9474): the draft restated in operator words, derived from the
 * same values the form edits plus the instance facts and project row.
 */

export interface DispatchSummaryProps {
	readonly project: ProjectRow | undefined;
	/** Git ref draft value — named gitRef because `ref` is a reserved JSX prop. */
	readonly gitRef: string;
	readonly seedId: string;
	readonly agent: string;
	readonly provider: string;
	readonly model: string;
	readonly costCap: string;
	/** Time limit draft text in minutes (warren-a112). */
	readonly timeLimit: string;
	/** Project's `.warren/config.yaml` `runBranchPrefix`, when declared. */
	readonly runBranchPrefix: string | undefined;
	readonly facts: InstanceFactsResponse | undefined;
	readonly routeState: DispatchRouteState;
	readonly valid: boolean;
	readonly actions: ReactNode;
}

function workspaceNote(props: DispatchSummaryProps): string | undefined {
	if (props.project === undefined) return undefined;
	const isolation = isolationLabel(props.facts?.runtime);
	const where = isolation === null ? "" : `, isolated in a ${isolation}`;
	if (props.routeState.continueFromRunId !== undefined) {
		return `Starts from the earlier run's pushed branch${where}`;
	}
	if (props.routeState.rescueFromRunId !== undefined) {
		return `Starts from the rescued work of the earlier run${where}`;
	}
	const ref = props.gitRef.trim().length > 0 ? props.gitRef.trim() : props.project.defaultBranch;
	return `Fresh clone of ${ref}${where}`;
}

export function buildDispatchSummaryRows(props: DispatchSummaryProps): SummaryRow[] {
	const repo = props.project
		? (repositoryLabel(props.project.gitUrl) ?? props.project.id)
		: "Pick a project";
	const cap = costCapLabel(props.costCap);
	const limit = timeLimitLabel(props.timeLimit);
	const seed = props.seedId.trim();
	const rows: SummaryRow[] = [
		{ icon: FolderGit2, label: "Workspace", value: repo, note: workspaceNote(props) },
		{
			icon: Bot,
			label: "Agent",
			value: props.agent.length > 0 ? props.agent : "Pick an agent",
			note: modelLabel(props.provider, props.model) ?? "The agent's default model",
		},
	];
	if (seed.length > 0) {
		rows.push({
			icon: Ticket,
			label: "Issue",
			value: <span className="font-mono">{seed}</span>,
			note: "Linked to the run",
		});
	}
	rows.push(
		{
			icon: Wallet,
			label: "Spend cap",
			value: cap ?? "None set here",
			note: cap
				? "The run stops when its spend crosses this"
				: "The agent's or project's cap applies, if one is set",
		},
		{
			icon: Timer,
			label: "Time limit",
			value: limit ?? "Agent default",
			note: limit
				? "The run is stopped and marked timed out after this long"
				: "The agent's or project's limit applies, if one is set",
		},
		{
			icon: GitBranch,
			label: "Delivers",
			value: <span className="font-mono">{runBranchValue(props.runBranchPrefix)}</span>,
			note: "A pushed branch, plus a pull request if the project opens them",
		},
	);
	return rows;
}

export function DispatchSummary(props: DispatchSummaryProps) {
	const manifest = buildManifestLines({
		project: props.project,
		ref: props.gitRef,
		seedId: props.seedId,
		agent: props.agent,
		provider: props.provider,
		model: props.model,
		costCap: props.costCap,
		timeLimit: props.timeLimit,
		runBranchPrefix: props.runBranchPrefix,
		runtime: props.facts?.runtime,
	});
	return (
		<SummaryCard
			rows={buildDispatchSummaryRows(props)}
			checks={buildAdmissionRows(props.project, props.facts)}
			manifest={manifest}
			valid={props.valid}
			actions={props.actions}
		/>
	);
}
