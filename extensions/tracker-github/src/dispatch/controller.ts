import { TrackerFailure } from "../errors.ts";
import type { GitHubClient } from "../github/client.ts";
import { parseIssueId } from "../github/issue.ts";
import type { DispatchConfig } from "./config.ts";
import type { DispatchStore } from "./store.ts";
import type { WarrenClient } from "./warren.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export class QueueController {
	private ticking = false;
	constructor(
		private readonly config: DispatchConfig,
		private readonly github: GitHubClient,
		private readonly warren: WarrenClient,
		private readonly store: DispatchStore,
		private readonly now: () => number = Date.now,
	) {}

	async tick(): Promise<void> {
		if (!this.config.enabled || this.ticking) return;
		this.ticking = true;
		try {
			await this.reconcile();
			await this.pickup();
		} finally {
			this.ticking = false;
		}
	}

	private async reconcile(): Promise<void> {
		for (const row of this.store.list()) {
			if (row.state !== "running" || row.runId === null) continue;
			// A failed poll isn't evidence that a run ended. Keep the reservation and stop this tick.
			const run = await this.warren.getRun(row.runId);
			if (TERMINAL.has(run.state))
				this.store.record(row.issueId, "settled", run.id, run.state, run.costUsd);
		}
	}

	private async pickup(): Promise<void> {
		for (const candidate of await this.github.listIssues()) {
			if (
				!this.store.hasCapacity(
					this.config.maxCostUsd,
					this.config.dailyBudgetUsd,
					this.config.maxConcurrent,
					this.now(),
				)
			)
				return;
			const projectId = this.config.projects[parseIssueId(candidate.id).repository.toLowerCase()];
			if (!projectId) continue; // An issue's presence in a cross-repo Project never grants a repository mapping.
			if (this.store.list().some((row) => row.issueId === candidate.id)) continue;
			await this.warren.verifyProject(projectId, candidate.repositoryUrl);
			const fresh = await this.github.getIssue(candidate.id);
			if (!fresh.ready) continue;
			if (
				!this.store.reserve(
					fresh.id,
					projectId,
					this.config.maxCostUsd,
					this.config.dailyBudgetUsd,
					this.config.maxConcurrent,
					this.now(),
				)
			)
				continue;
			try {
				const run = await this.warren.dispatch(projectId, fresh.id);
				this.store.record(
					fresh.id,
					TERMINAL.has(run.state) ? "settled" : "running",
					run.id,
					null,
					run.costUsd,
				);
			} catch (error) {
				const rejected = error instanceof TrackerFailure && error.code === "warren_rejected";
				this.store.record(
					fresh.id,
					rejected ? "rejected" : "uncertain",
					null,
					rejected
						? "Dispatch refused; requires operator review"
						: "Dispatch outcome unknown; inspect Warren before taking further action",
				);
				throw error;
			}
		}
	}
}
