import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import type { ProjectRow } from "@/api/types.ts";
import { parseCostCap, parseTimeLimit } from "./dispatch-draft.ts";

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
	/** Time limit draft text (warren-a112); absent reads as unset. */
	readonly timeLimit?: string;
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
		{ indent: true, key: "branch: ", value: runBranchValue(input.runBranchPrefix) },
		{ key: "runtime:" },
		{ indent: true, key: "provider: ", value: input.runtime ?? "—" },
		{ indent: true, key: "adapter: ", value: input.agent.length > 0 ? input.agent : "—" },
		{ indent: true, key: "model: ", value: modelValue(input.provider, input.model) },
		{ key: "limits:" },
		{ indent: true, key: "costUsd: ", value: costValue(input.costCap) },
		{ indent: true, key: "durationMinutes: ", value: minutesValue(input.timeLimit ?? "") },
		{ key: "delivery:" },
		{ indent: true, key: "pushBranch: ", value: "true" },
	];
}

export function modelValue(provider: string, model: string): string {
	if (provider.length > 0 && model.length > 0) return `${provider}/${model}`;
	if (model.length > 0) return model;
	if (provider.length > 0) return provider;
	return "—";
}

function costValue(costCap: string): string {
	const parsed = parseCostCap(costCap);
	return parsed !== null && "value" in parsed ? parsed.value.toFixed(2) : "—";
}

function minutesValue(timeLimit: string): string {
	const parsed = parseTimeLimit(timeLimit);
	return parsed !== null && "value" in parsed ? String(parsed.value) : "—";
}

/** The branch a new run pushes: `<prefix>/<run id>`; warren's default prefix is `warren`. */
export function runBranchValue(prefix: string | undefined): string {
	return `${prefix ?? "warren"}/<run id>`;
}

/** Where the agent's workspace is sandboxed, in operator words. */
export function isolationLabel(
	runtime: InstanceFactsResponse["runtime"] | undefined,
): string | null {
	switch (runtime) {
		case "k8s":
			return "Kubernetes pod";
		case "docker":
			return "Docker container";
		case "local":
			return "local sandbox";
		default:
			return null;
	}
}

/** `"5"` → `"$5.00"`; unset or invalid → null. */
export function costCapLabel(costCap: string): string | null {
	const parsed = parseCostCap(costCap);
	return parsed !== null && "value" in parsed ? `$${parsed.value.toFixed(2)}` : null;
}

/** `"60"` → `"60 min"`; unset or invalid → null (warren-a112). */
export function timeLimitLabel(timeLimit: string): string | null {
	const parsed = parseTimeLimit(timeLimit);
	return parsed !== null && "value" in parsed ? `${parsed.value} min` : null;
}

/** Provider/model pair for display; empty → null (the agent's default applies). */
export function modelLabel(provider: string, model: string): string | null {
	const value = modelValue(provider, model);
	return value === "—" ? null : value;
}

/**
 * The pre-flight checks the summary rail lists, in display order. Only
 * facts the UI can read are listed; a check it cannot verify is left out
 * rather than shown as a permanent unknown.
 */
export function buildAdmissionRows(
	project: ProjectRow | undefined,
	facts: InstanceFactsResponse | undefined,
): readonly AdmissionRow[] {
	const rows: AdmissionRow[] = [];
	const isolation = isolationLabel(facts?.runtime);
	rows.push({
		label: "Isolated workspace",
		value: isolation === null ? "—" : capitalize(isolation),
		status: isolation === null ? "unknown" : "ok",
	});
	rows.push({
		label: "Issue tracker",
		value: project ? (project.hasSeeds ? "Seeds" : "None") : "—",
		status: project ? (project.hasSeeds ? "ok" : "absent") : "unknown",
	});
	const caps = facts?.admission;
	if (caps !== undefined && caps !== null) {
		rows.push({
			label: "Concurrency limit",
			value:
				caps.maxProjectConcurrency !== null
					? `${caps.maxProjectConcurrency} per project`
					: "No per-project limit",
			status: "ok",
		});
	}
	return rows;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
