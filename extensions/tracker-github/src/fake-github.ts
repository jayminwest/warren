/** Stateful GitHub boundary fixture; all code above fetch is the real adapter. */
import type { Fetch } from "./github/transport.ts";

export interface FixtureIssue {
	number: number;
	repository: string;
	state?: "OPEN" | "CLOSED";
	labels?: string[];
	status?: string | null;
	archived?: boolean;
	type?: "Issue" | "PullRequest" | "DraftIssue" | "Redacted";
}
export class FakeGitHub {
	readonly requests: { url: string; method: string; body: unknown }[] = [];
	issues: FixtureIssue[] = [
		{ number: 1, repository: "acme/web", labels: ["agent"], status: "Ready" },
	];
	pageSize = 100;
	project = "P1";
	fields = [
		{
			id: "F1",
			name: "Status",
			options: [
				{ id: "ready", name: "Ready" },
				{ id: "review", name: "In review" },
			],
		},
	];
	error?: Response;
	projectClosed = false;

	private connection(nodes: unknown[], cursor: unknown): unknown {
		const offset = cursor === null || cursor === undefined ? 0 : Number(cursor);
		const next = offset + this.pageSize;
		return {
			nodes: nodes.slice(offset, next),
			pageInfo: {
				hasNextPage: next < nodes.length,
				endCursor: next < nodes.length ? String(next) : null,
			},
		};
	}
	private rest(issue: FixtureIssue) {
		return {
			number: issue.number,
			title: `Task ${issue.number}`,
			body: "Acceptance: tests pass",
			state: (issue.state ?? "OPEN").toLowerCase(),
			html_url: `https://github.com/${issue.repository}/issues/${issue.number}`,
			labels: (issue.labels ?? []).map((name) => ({ name })),
			...(issue.type === "PullRequest" ? { pull_request: {} } : {}),
		};
	}
	private item(issue: FixtureIssue) {
		const field = this.fields.find((field) => field.name === "Status");
		const option = field?.options.find((option) => option.name === issue.status);
		return {
			id: `item-${issue.number}`,
			isArchived: issue.archived ?? false,
			fieldValueByName: option
				? { optionId: option.id, name: option.name, field: { id: field?.id } }
				: null,
			content:
				issue.type === "Redacted"
					? null
					: {
							__typename: issue.type ?? "Issue",
							id: `I${issue.number}`,
							number: issue.number,
							title: `Task ${issue.number}`,
							body: "Acceptance: tests pass",
							state: issue.state ?? "OPEN",
							url: `https://github.com/${issue.repository}/issues/${issue.number}`,
							repository: {
								nameWithOwner: issue.repository,
								url: `https://github.com/${issue.repository}`,
							},
							labels: this.connection(
								(issue.labels ?? []).map((name) => ({ name })),
								null,
							),
						},
		};
	}

	readonly fetch: Fetch = async (input, init) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as {
					query?: string;
					variables?: Record<string, unknown>;
					state?: string;
				})
			: undefined;
		const method = init?.method ?? "GET";
		this.requests.push({ url: url.href, method, body });
		if (this.error) return this.error.clone();
		if (url.pathname === "/graphql" && body?.query) {
			const v = body.variables ?? {};
			if (body.query.includes("projectV2(number:")) {
				const ownerType = body.query.includes("organization(login:") ? "organization" : "user";
				return Response.json({
					data: { [ownerType]: { projectV2: { id: this.project, closed: this.projectClosed } } },
				});
			}
			if (body.query.includes("fields(first:"))
				return Response.json({ data: { node: { fields: this.connection(this.fields, v.after) } } });
			if (body.query.includes("items(first:"))
				return Response.json({
					data: {
						node: {
							items: this.connection(
								this.issues.map((issue) => this.item(issue)),
								v.after,
							),
						},
					},
				});
			if (body.query.includes("labels(first:")) {
				const issue = this.issues.find((issue) => `I${issue.number}` === v.id);
				return Response.json({
					data: {
						node: {
							labels: this.connection(
								(issue?.labels ?? []).map((name) => ({ name })),
								v.after,
							),
						},
					},
				});
			}
		}
		const path = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/.exec(url.pathname);
		if (path) {
			const issues = this.issues.filter(
				(issue) => issue.repository.toLowerCase() === path[1]?.toLowerCase(),
			);
			if (path[2]) {
				const issue = issues.find((issue) => issue.number === Number(path[2]));
				if (!issue) return Response.json({ message: "Not Found" }, { status: 404 });
				if (method === "PATCH") issue.state = "CLOSED";
				return Response.json(this.rest(issue));
			}
			const page = Number(url.searchParams.get("page") ?? "1");
			const slice = issues.slice((page - 1) * this.pageSize, page * this.pageSize);
			return Response.json(
				slice.map((issue) => this.rest(issue)),
				{
					headers:
						page * this.pageSize < issues.length
							? { link: '<https://github.invalid/ignored>; rel="next"' }
							: {},
				},
			);
		}
		return Response.json({ message: "unexpected fixture request" }, { status: 404 });
	};
}
