import { TrackerError } from "../core/wire.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { IssueTracker, TrackerContext } from "./contract.ts";
import { assertTrackerEndpointAllowed } from "./remote/endpoint-policy.ts";
import { buildRemoteTracker, type EnvLike } from "./remote/from-config.ts";

/** Routes each operation using the project's current config, never a global first-project choice. */
export class ProjectTracker implements IssueTracker {
	readonly capabilities = {
		supportsPlans: false,
		supportsMetadata: false,
		supportsScheduledIssues: false,
		isGitNative: false,
	};
	private readonly remotes = new Map<string, { key: string; tracker: Promise<IssueTracker> }>();

	constructor(
		private readonly configs: WarrenConfigCache,
		private readonly env: EnvLike,
		private readonly fallback: IssueTracker,
	) {}

	async resolveForProject(ctx: TrackerContext): Promise<IssueTracker> {
		if (!ctx.localPath)
			throw new TrackerError("Project tracker resolution requires a project clone path");
		const loaded = await this.configs.get(ctx.projectId, ctx.localPath);
		if (
			loaded.errors.some(
				(error) =>
					error.file === "config.yaml" ||
					error.file === "defaults.json" ||
					error.file.endsWith("/config.yaml") ||
					error.file.endsWith("/defaults.json"),
			)
		) {
			throw new TrackerError(
				"Project tracker configuration is invalid; refusing to fall back to another tracker",
			);
		}
		const config = loaded.defaults?.tracker;
		if (!config) {
			this.remotes.delete(ctx.projectId);
			return this.fallback;
		}
		assertTrackerEndpointAllowed(config, this.env);
		const key = JSON.stringify(config);
		const hit = this.remotes.get(ctx.projectId);
		if (hit?.key === key) return hit.tracker;
		const tracker = buildRemoteTracker({ config, env: this.env, overrides: { cacheTtlMs: 0 } });
		const pending = tracker
			.connect()
			.then(() => tracker)
			.catch((error: unknown) => {
				if (this.remotes.get(ctx.projectId)?.tracker === pending)
					this.remotes.delete(ctx.projectId);
				throw error;
			});
		this.remotes.set(ctx.projectId, { key, tracker: pending });
		return pending;
	}

	async getIssue(ctx: TrackerContext, id: string) {
		return (await this.resolveForProject(ctx)).getIssue(ctx, id);
	}
	async listIssueStatuses(ctx: TrackerContext) {
		return (await this.resolveForProject(ctx)).listIssueStatuses(ctx);
	}
	async closeIssue(ctx: TrackerContext, id: string) {
		await (await this.resolveForProject(ctx)).closeIssue(ctx, id);
	}
}
