import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import { parseCostCap } from "./dispatch-draft.ts";

/**
 * Pure derivations behind the Dispatch page's resolved-manifest rail
 * (warren-bbe8): the manifest lines and admission rows are computed from
 * real client-held data only. Kept out of the component so each piece
 * stays small and independently testable.
 */

export interface ManifestLine {
	readonly indent?: boolean;
	readonly key: string;
	readonly value?: string;
}

export type AdmissionStatus = "ok" | "absent" | "unknown";

export interface AdmissionRow {
	readonly label: string;
	readonly value: string;
	readonly status: AdmissionStatus;
	/** Hover hint naming what would light the row up. */
	readonly title?: string;
}

/** `github.com/jayminwest/warren` → `jayminwest/warren`; unparseable → null. */
export function repositoryLabel(gitUrl: string): string | null {
	const match = gitUrl.match(/(?:github\.com[/:])([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
	if (!match) return null;
	return `${match[1]}/${match[2]}`;
}

export interface ManifestInput {
	readonly project: ProjectRow | undefined;
	readonly ref: string;
	readonly seedId: string;
	readonly agent: string;
	readonly provider: string;
	readonly model: string;
	readonly costCap: string;
	readonly runBranchPrefix: string | undefined;
	readonly runtime: InstanceFactsResponse["runtime"] | undefined;
}

/** The resolved manifest the right rail renders, in display order. */
export function buildManifestLines(input: ManifestInput): readonly ManifestLine[] {
	const { project } = input;
	const ref = input.ref.trim().length > 0 ? input.ref.trim() : (project?.defaultBranch ?? "—");
	const repository = project ? (repositoryLabel(project.gitUrl) ?? "—") : "—";
	return [
		{ key: "apiVersion: ", value: "warren.run/v1" },
		{ key: "kind: ", value: "AgentRun" },
		{ key: "metadata:" },
		{ indent: true, key: "project: ", value: project ? project.id : "—" },
		{
			indent: true,
			key: "tracker: ",
			value: input.seedId.trim().length > 0 ? input.seedId.trim() : "—",
		},
		{ key: "workspace:" },
		{ indent: true, key: "repository: ", value: repository },
		{ indent: true, key: "ref: ", value: ref },
		{ indent: true, key: "branch: ", value: `${input.runBranchPrefix ?? "burrow"}/<new run>` },
		{ key: "runtime:" },
		{ indent: true, key: "provider: ", value: input.runtime ?? "—" },
		{ indent: true, key: "adapter: ", value: input.agent.length > 0 ? input.agent : "—" },
		{ indent: true, key: "model: ", value: modelValue(input.provider, input.model) },
		{ key: "limits:" },
		{ indent: true, key: "costUsd: ", value: costValue(input.costCap) },
		{ key: "delivery:" },
		{ indent: true, key: "pushBranch: ", value: "true" },
	];
}

/**
 * The mobile summary projection (pl-4ab6 / warren-5cf7): the dispatch mock's
 * 7 flat lines. The full manifest stays md+; phones render this projection.
 */
export function buildManifestSummaryLines(input: ManifestInput): readonly ManifestLine[] {
	return [
		{ key: "apiVersion: ", value: "warren.run/v1" },
		{ key: "kind: ", value: "AgentRun" },
		{ key: "project: ", value: input.project ? input.project.id : "—" },
		{
			key: "tracker: ",
			value: input.seedId.trim().length > 0 ? input.seedId.trim() : "—",
		},
		{ key: "branch: ", value: `${input.runBranchPrefix ?? "burrow"}/<new run>` },
		{ key: "costUsd: ", value: costValue(input.costCap) },
		{ key: "openPullRequest: ", value: "configured" },
	];
}

function modelValue(provider: string, model: string): string {
	if (provider.length > 0 && model.length > 0) return `${provider}/${model}`;
	if (model.length > 0) return model;
	if (provider.length > 0) return provider;
	return "—";
}

function costValue(costCap: string): string {
	const parsed = parseCostCap(costCap);
	return parsed !== null && "value" in parsed ? parsed.value.toFixed(2) : "—";
}

function isolationRow(runtime: InstanceFactsResponse["runtime"] | undefined): AdmissionRow {
	switch (runtime) {
		case "k8s":
			return { label: "Workspace isolation", value: "POD BOUNDARY", status: "ok" };
		case "docker":
			return { label: "Workspace isolation", value: "CONTAINER BOUNDARY", status: "ok" };
		case "local":
			return { label: "Workspace isolation", value: "BWRAP PROFILE", status: "ok" };
		default:
			return { label: "Workspace isolation", value: "—", status: "unknown" };
	}
}

/** The admission-policy rows the right rail renders, in display order. */
export function buildAdmissionRows(
	project: ProjectRow | undefined,
	facts: InstanceFactsResponse | undefined,
): readonly AdmissionRow[] {
	const rows: AdmissionRow[] = [
		isolationRow(facts?.runtime),
		{
			label: "Forge credential",
			value: "—",
			status: "unknown",
			title: "No forge-credential status API yet",
		},
		{
			label: "Git hooks",
			value: "—",
			status: "unknown",
			title: "No per-project hook-status API yet",
		},
		{
			label: "Issue queue",
			value: project ? (project.hasSeeds ? ".seeds PRESENT" : "NO .seeds") : "—",
			status: project ? (project.hasSeeds ? "ok" : "absent") : "unknown",
		},
	];
	const caps = facts?.admission;
	if (caps !== undefined && caps !== null) {
		rows.push({
			label: "Admission cap",
			value:
				caps.maxProjectConcurrency !== null
					? `PROJECT ≤${caps.maxProjectConcurrency}`
					: "PROJECT UNCAPPED",
			status: "ok",
			title: `WARREN_K8S_MAX_QUEUE_DEPTH ${caps.maxQueueDepth} · MAX_PENDING_PODS ${caps.maxPendingPods}`,
		});
	}
	return rows;
}
