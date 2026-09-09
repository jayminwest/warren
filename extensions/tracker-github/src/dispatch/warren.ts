import { object, string, TrackerFailure } from "../errors.ts";
import type { Fetch } from "../github/transport.ts";
import type { DispatchConfig } from "./config.ts";

export interface Run {
	id: string;
	state: string;
	costUsd: number | null;
}

/** Only the published Warren API. GitHub credentials never reach Warren. */
export class WarrenClient {
	constructor(
		private readonly config: DispatchConfig,
		private readonly fetchImpl: Fetch = fetch,
	) {}

	private async request(path: string, body?: unknown): Promise<Response> {
		try {
			return await this.fetchImpl(`${this.config.baseUrl}${path}`, {
				method: body === undefined ? "GET" : "POST",
				redirect: "error",
				signal: AbortSignal.timeout(120000),
				headers: {
					authorization: `Bearer ${this.config.token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new TrackerFailure("warren_uncertain", "Warren did not return a confirmed result", 503);
		}
	}

	private async run(response: Response): Promise<Run> {
		if (!response.ok)
			throw new TrackerFailure(
				"warren_read_failed",
				`Warren returned HTTP ${response.status}`,
				503,
			);
		try {
			const run = object(object(await response.json()).run);
			const costUsd = run.costUsd;
			if (
				costUsd !== null &&
				costUsd !== undefined &&
				(typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
			)
				throw new Error("invalid cost");
			return {
				id: string(run.id),
				state: string(run.state),
				costUsd: typeof costUsd === "number" ? costUsd : null,
			};
		} catch {
			throw new TrackerFailure("warren_uncertain", "Warren returned an invalid run response", 503);
		}
	}

	async verifyProject(projectId: string, repositoryUrl: string): Promise<void> {
		const response = await this.request(`/projects/${encodeURIComponent(projectId)}`);
		if (!response.ok)
			throw new TrackerFailure(
				"warren_project_unavailable",
				"Cannot verify the configured Warren project",
				409,
			);
		const project = object(await response.json());
		const normalize = (value: string) =>
			value
				.replace(/^git@([^:]+):/, "https://$1/")
				.replace(/\.git\/?$/, "")
				.replace(/\/$/, "")
				.toLowerCase();
		if (normalize(string(project.gitUrl)) !== normalize(repositoryUrl))
			throw new TrackerFailure(
				"repository_mismatch",
				"Warren project does not match the issue repository",
				409,
			);
	}

	async dispatch(projectId: string, issueId: string): Promise<Run> {
		const response = await this.request(
			`/projects/${encodeURIComponent(projectId)}/issues/dispatch`,
			{
				issueId,
				agent: this.config.agent,
				maxCostUsd: this.config.maxCostUsd,
			},
		);
		// 4xx is a considered refusal. 5xx and malformed success are ambiguous mutations.
		if (response.status >= 400 && response.status < 500)
			throw new TrackerFailure(
				"warren_rejected",
				`Warren refused dispatch (HTTP ${response.status})`,
				409,
			);
		return this.run(response);
	}

	getRun(id: string): Promise<Run> {
		return this.request(`/runs/${encodeURIComponent(id)}`).then((response) => this.run(response));
	}
}
