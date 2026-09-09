import { ValidationError } from "../../core/errors.ts";
import { spawnIssueRun } from "../../runs/spawn/dispatch.ts";
import { assertExecutableIssue } from "../../runs/spawn/issue-dispatch.ts";
import type { IssueListingTracker } from "../../tracker/contract.ts";
import { resolveIssueTracker } from "../../tracker/resolve.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { readJsonBody, requireParam, requireString } from "./index.ts";
import { buildHttpSpawnOptions } from "./runs/dispatch.ts";

export function listProjectIssuesHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = await deps.repos.projects.require(requireParam(ctx, "id"));
		if (!deps.issueTracker) return jsonResponse(200, { supported: false, issues: [] });
		const context = { projectId: project.id, localPath: project.localPath };
		const tracker = await resolveIssueTracker(deps.issueTracker, context);
		if (!tracker.capabilities.supportsIssueListing)
			return jsonResponse(200, { supported: false, issues: [] });
		const candidates = await (tracker as unknown as IssueListingTracker).listIssues(context);
		const issues = [];
		for (const issue of candidates) {
			try {
				assertExecutableIssue(issue, project.gitUrl);
			} catch {
				continue;
			}
			const run = await deps.repos.runs.findByIssue(project.id, issue.id);
			issues.push({ ...issue, runId: run?.id ?? null, runState: run?.state ?? null });
		}
		return jsonResponse(200, { supported: true, issues });
	};
}

export function dispatchProjectIssueHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const issueId = requireString(body, "issueId");
		if (
			Object.keys(body).some(
				(key) =>
					!["issueId", "agent", "maxCostUsd", "providerOverride", "modelOverride"].includes(key),
			)
		) {
			throw new ValidationError(
				"Issue dispatch accepts issueId, agent, maxCostUsd, providerOverride and modelOverride only",
			);
		}
		await deps.repos.projects.require(projectId);
		const prior = await deps.repos.runs.findByIssue(projectId, issueId);
		if (prior) return jsonResponse(200, { run: prior, reused: true });
		const options = await buildHttpSpawnOptions(
			deps,
			{
				...body,
				project: projectId,
				seedId: issueId,
				prompt: "Run the repository's checks and report the result. Do not merge or deploy.",
			},
			ctx.logger,
		);
		const result = await spawnIssueRun(options);
		if (result.spawned)
			deps.bridges.start(result.run.id, result.spawned.sandboxRun.id, result.spawned.sandbox.id);
		return jsonResponse(result.spawned ? 201 : 200, { run: result.run, reused: !result.spawned });
	};
}
