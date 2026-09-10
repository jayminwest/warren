import type { GitHubConfig, ProjectScope } from "../config.ts";
import { array, malformed, object, string, TrackerFailure } from "../errors.ts";
import { type IssueRecord, inRepository, number, state } from "./issue.ts";
import { nextCursor, pageLimit } from "./pagination.ts";
import type { GitHubTransport } from "./transport.ts";

interface ProjectInfo {
	id: string;
	fieldId?: string;
	readyStatusIds?: ReadonlySet<string>;
}

const FIELDS = `query($id:ID!,$after:String){node(id:$id){...on ProjectV2{fields(first:100,after:$after){nodes{...on ProjectV2SingleSelectField{id name options{id name}}}pageInfo{hasNextPage endCursor}}}}}`;
const ITEMS = `query($id:ID!,$after:String,$field:String!){node(id:$id){...on ProjectV2{items(first:100,after:$after){nodes{id isArchived fieldValueByName(name:$field){...on ProjectV2ItemFieldSingleSelectValue{optionId name field{...on ProjectV2SingleSelectField{id}}}}content{__typename ...on Issue{id number title body state url repository{nameWithOwner url}labels(first:100){nodes{name}pageInfo{hasNextPage endCursor}}}}}pageInfo{hasNextPage endCursor}}}}}`;
const LABELS = `query($id:ID!,$after:String){node(id:$id){...on Issue{labels(first:100,after:$after){nodes{name}pageInfo{hasNextPage endCursor}}}}}`;

export class ProjectReader {
	constructor(
		private readonly config: GitHubConfig,
		private readonly transport: GitHubTransport,
	) {}

	async resolve(scope: ProjectScope): Promise<ProjectInfo> {
		// ownerType is a validated enum, not free text interpolated into a query.
		const query = `query($owner:String!,$number:Int!){${scope.ownerType}(login:$owner){projectV2(number:$number){id closed}}}`;
		const data = await this.transport.graphql(query, { owner: scope.owner, number: scope.number });
		const owner = data[scope.ownerType];
		if (owner === null || object(owner).projectV2 === null)
			throw new TrackerFailure(
				"project_not_found",
				"Configured GitHub Project was not found or is not accessible",
				404,
			);
		const project = object(object(owner).projectV2);
		if (project.closed !== false)
			throw new TrackerFailure(
				"project_closed",
				"Configured GitHub Project is closed or its state is unavailable",
				409,
			);
		const id = string(project.id);
		if (scope.readyStatuses.length === 0) return { id };
		return { id, ...(await this.statusField(id, scope)) };
	}

	private async statusField(
		id: string,
		scope: ProjectScope,
	): Promise<{ fieldId: string; readyStatusIds: ReadonlySet<string> }> {
		let after: string | null = null;
		const seen = new Set<string>();
		const matches: Record<string, unknown>[] = [];
		for (let page = 0; page < this.config.maxPages; page++) {
			const data = await this.transport.graphql(FIELDS, { id, after });
			const connection = object(object(data.node).fields);
			for (const value of array(connection.nodes)) {
				const field = object(value);
				if (field.name === scope.statusField) matches.push(field);
			}
			after = nextCursor(connection.pageInfo, seen);
			if (after === null) return this.matchStatusField(matches, scope);
		}
		return pageLimit();
	}

	private matchStatusField(
		matches: Record<string, unknown>[],
		scope: ProjectScope,
	): { fieldId: string; readyStatusIds: ReadonlySet<string> } {
		if (matches.length !== 1)
			throw new TrackerFailure(
				"invalid_status_field",
				"Configured Project status field must identify exactly one single-select field",
				422,
			);
		const field = matches[0];
		if (!field) return malformed();
		const options = array(field.options).map(object);
		const ids = scope.readyStatuses.map((name) => {
			const matches = options.filter((option) => option.name === name);
			if (matches.length !== 1 || !matches[0])
				throw new TrackerFailure(
					"invalid_ready_status",
					"A configured ready status does not identify exactly one Project field option",
					422,
				);
			return string(matches[0].id);
		});
		return { fieldId: string(field.id), readyStatusIds: new Set(ids) };
	}

	async issues(
		scope: ProjectScope,
	): Promise<{ issues: IssueRecord[]; readyStatusIds?: ReadonlySet<string> }> {
		const project = await this.resolve(scope);
		let after: string | null = null;
		const seen = new Set<string>();
		const issues = new Map<string, IssueRecord>();
		for (let page = 0; page < this.config.maxPages; page++) {
			const data = await this.transport.graphql(ITEMS, {
				id: project.id,
				after,
				field: scope.statusField,
			});
			const connection = object(object(data.node).items);
			for (const value of array(connection.nodes)) {
				const issue = await this.item(value, project.fieldId);
				if (issue) issues.set(`${issue.repository.toLowerCase()}#${issue.number}`, issue);
			}
			after = nextCursor(connection.pageInfo, seen);
			if (after === null)
				return { issues: [...issues.values()], readyStatusIds: project.readyStatusIds };
		}
		return pageLimit();
	}

	private async item(value: unknown, fieldId?: string): Promise<IssueRecord | null> {
		const item = object(value);
		if (item.isArchived === true) return null;
		if (item.isArchived !== false) return malformed();
		// Drafts, PRs and redacted/deleted content are not executable repository issues.
		if (item.content === null) return null;
		const content = object(item.content);
		if (content.__typename !== "Issue") return null;
		const repo = object(content.repository);
		const repository = string(repo.nameWithOwner);
		if (!inRepository(this.config, repository)) return null;
		const status = item.fieldValueByName === null ? undefined : object(item.fieldValueByName);
		if (fieldId && status && object(status.field).id !== fieldId) return malformed();
		return {
			repository,
			number: number(content.number),
			title: string(content.title),
			body: string(content.body),
			state: state(content.state),
			url: string(content.url),
			repositoryUrl: string(repo.url),
			labels: await this.labels(string(content.id), object(content.labels)),
			...(status?.name === undefined
				? {}
				: { projectStatus: string(status.name), projectStatusId: string(status.optionId) }),
		};
	}

	private async labels(id: string, initial: Record<string, unknown>): Promise<string[]> {
		let connection = initial;
		const labels: string[] = [];
		const seen = new Set<string>();
		for (let page = 0; page < this.config.maxPages; page++) {
			labels.push(...array(connection.nodes).map((label) => string(object(label).name)));
			const after = nextCursor(connection.pageInfo, seen);
			if (after === null) return labels;
			connection = object(
				object((await this.transport.graphql(LABELS, { id, after })).node).labels,
			);
		}
		return pageLimit();
	}
}
