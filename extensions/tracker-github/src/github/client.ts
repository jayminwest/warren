import type { GitHubConfig } from "../config.ts";
import { array, TrackerFailure } from "../errors.ts";
import {
	type GitHubIssue,
	type IssueRecord,
	inRepository,
	parseIssueId,
	projectIssue,
	restIssue,
} from "./issue.ts";
import { pageLimit } from "./pagination.ts";
import { ProjectReader } from "./project.ts";
import { type Fetch, GitHubTransport } from "./transport.ts";

export class GitHubClient {
	readonly transport: GitHubTransport;
	private readonly projects: ProjectReader;
	constructor(
		readonly config: GitHubConfig,
		fetchImpl?: Fetch,
	) {
		this.transport = new GitHubTransport(config, fetchImpl);
		this.projects = new ProjectReader(config, this.transport);
	}

	async listIssues(readyOnly = true): Promise<GitHubIssue[]> {
		const { issues, readyStatusIds } = this.config.project
			? await this.projects.issues(this.config.project)
			: { issues: await this.repositoryIssues(), readyStatusIds: undefined };
		return issues
			.map((issue) => projectIssue(this.config, issue, readyStatusIds))
			.filter((issue) => !readyOnly || issue.ready)
			.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
	}

	private async repositoryIssues(): Promise<IssueRecord[]> {
		const repository = this.config.repository;
		if (!repository) throw new TrackerFailure("invalid_scope", "Repository scope is required", 422);
		const result = new Map<number, IssueRecord>();
		for (let page = 1; page <= this.config.maxPages; page++) {
			const url = `${this.config.apiUrl}/repos/${repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`;
			const response = await this.transport.request(url, "GET");
			for (const value of array(response.body)) {
				const issue = restIssue(value, repository);
				if (issue) result.set(issue.number, issue);
			}
			if (!/rel="next"/.test(response.headers.get("link") ?? "")) return [...result.values()];
		}
		return pageLimit();
	}

	async getIssue(id: string): Promise<GitHubIssue> {
		let parsed: ReturnType<typeof parseIssueId>;
		try {
			parsed = parseIssueId(id);
		} catch {
			return this.notFound();
		}
		const { repository, number } = parsed;
		if (!inRepository(this.config, repository)) return this.notFound();
		if (this.config.project) {
			const issue = (await this.listIssues(false)).find(
				(issue) => issue.id === `${repository.toLowerCase()}#${number}`,
			);
			return issue ?? this.notFound();
		}
		try {
			const { body } = await this.transport.request(
				`${this.config.apiUrl}/repos/${repository}/issues/${number}`,
				"GET",
			);
			const issue = restIssue(body, repository);
			return issue ? projectIssue(this.config, issue) : this.notFound();
		} catch (error) {
			if (error instanceof TrackerFailure && error.code === "upstream_not_found")
				return this.notFound();
			throw error;
		}
	}

	async closeIssue(id: string): Promise<void> {
		const issue = await this.getIssue(id);
		if (issue.status === "closed") return;
		if (!this.config.allowClose)
			throw new TrackerFailure(
				"close_disabled",
				"GitHub issue closing is disabled; set GITHUB_ALLOW_CLOSE=true to opt in",
				403,
			);
		const { repository, number } = parseIssueId(id);
		await this.transport.request(
			`${this.config.apiUrl}/repos/${repository}/issues/${number}`,
			"PATCH",
			{ state: "closed", state_reason: "completed" },
		);
	}

	private notFound(): never {
		throw new TrackerFailure(
			"issue_not_found",
			"Issue was not found in the configured scope or is not accessible",
			404,
		);
	}
}
