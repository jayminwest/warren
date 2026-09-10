import { type GitHubConfig, REPOSITORY } from "../config.ts";
import { array, malformed, object, string, TrackerFailure } from "../errors.ts";

export interface GitHubIssue {
	readonly id: string;
	readonly status: "open" | "closed";
	readonly title: string;
	readonly description: string;
	readonly url: string;
	readonly repositoryUrl: string;
	readonly ready: boolean;
	readonly metadata: { readonly labels: readonly string[]; readonly projectStatus?: string };
}

export interface IssueRecord {
	readonly repository: string;
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: "open" | "closed";
	readonly url: string;
	readonly repositoryUrl: string;
	readonly labels: readonly string[];
	readonly projectStatus?: string;
	readonly projectStatusId?: string;
}

export function parseIssueId(id: string): { repository: string; number: number } {
	const split = id.lastIndexOf("#");
	const repository = id.slice(0, split);
	const raw = id.slice(split + 1);
	const number = Number(raw);
	if (
		split < 1 ||
		!REPOSITORY.test(repository) ||
		!/^[1-9]\d*$/.test(raw) ||
		!Number.isSafeInteger(number)
	) {
		throw new TrackerFailure("invalid_issue_id", "issue id must be owner/repo#number", 400);
	}
	return { repository, number };
}

export function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return malformed();
	return value;
}

export function state(value: unknown): "open" | "closed" {
	if (value === "open" || value === "OPEN") return "open";
	if (value === "closed" || value === "CLOSED") return "closed";
	return malformed();
}

export function restIssue(value: unknown, repository: string): IssueRecord | null {
	const raw = object(value);
	if (raw.pull_request !== undefined) return null;
	const url = string(raw.html_url);
	const parsed = new URL(url);
	if (
		parsed.protocol !== "https:" ||
		parsed.pathname.toLowerCase() !== `/${repository}/issues/${number(raw.number)}`.toLowerCase()
	)
		return malformed();
	return {
		repository,
		number: number(raw.number),
		title: string(raw.title),
		body: raw.body === null ? "" : string(raw.body),
		state: state(raw.state),
		url,
		repositoryUrl: `${parsed.origin}/${repository}`,
		labels: array(raw.labels).map((label) =>
			typeof label === "string" ? label : string(object(label).name),
		),
	};
}

export function inRepository(config: GitHubConfig, repository: string): boolean {
	return (
		config.repository === undefined || config.repository.toLowerCase() === repository.toLowerCase()
	);
}

export function projectIssue(
	config: GitHubConfig,
	issue: IssueRecord,
	readyStatusIds?: ReadonlySet<string>,
): GitHubIssue {
	const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
	const checks = config.labels.map((label) => labels.has(label.toLowerCase()));
	const labelsMatch =
		checks.length === 0 ||
		(config.labelMode === "all" ? checks.every(Boolean) : checks.some(Boolean));
	const statusMatch =
		readyStatusIds === undefined ||
		(issue.projectStatusId !== undefined && readyStatusIds.has(issue.projectStatusId));
	return {
		id: `${issue.repository.toLowerCase()}#${issue.number}`,
		status: issue.state,
		title: issue.title,
		description: issue.body,
		url: issue.url,
		repositoryUrl: issue.repositoryUrl,
		ready: issue.state === "open" && labelsMatch && statusMatch,
		metadata: {
			labels: issue.labels,
			...(issue.projectStatus === undefined ? {} : { projectStatus: issue.projectStatus }),
		},
	};
}
