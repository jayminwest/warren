/**
 * Plot aggregation across all `hasPlot=true` projects
 * (warren-7e85 / pl-9d6a step 1).
 *
 * Single facade over the per-project `UserPlotClient` instances. Used
 * by:
 *
 *   - `GET /plots` (warren-c167) — list across the deployment, optional
 *     status filter.
 *   - `PlotResolver` (./resolver.ts) — find the owning project for a
 *     given `plot_id` by scanning every `hasPlot` project's index.
 *
 * Posture mirrors `src/runs/spawn.ts`'s `defaultPlotAppender` and
 * `src/plan-runs/plot-appender.ts` (mx-239786 / mx-92e6b3): on a
 * first-attempt query failure the index is rebuilt best-effort and the
 * query is retried once. The retry covers the documented case where a
 * project has a `.plot/` directory but no `.index.db` yet (the index
 * is reconstructible from the JSON files at any time — Plot SPEC §4.1).
 *
 * Per-project queries fan out in parallel via `Promise.all`. A failure
 * inside any single project's branch is logged and DROPPED from the
 * aggregated result — one broken `.plot/` directory must not 500 the
 * deployment-wide list. The handler-level shape stays consistent with
 * the empty-deployments contract (next paragraph).
 *
 * Empty-deployment contract (pinned by tests): when zero projects have
 * `hasPlot=true`, `listPlotSummaries` returns the exact same empty
 * array reference every call. That preserves the "byte-identical when
 * no Plot is in use" property GET /plots needs so standalone warren
 * deployments don't see any new bytes once they walk the API surface.
 *
 * Cache: 5s in-memory, keyed by `project_id`. Each per-project entry
 * stores the unfiltered `PlotSummary[]` for that project; the status
 * filter is applied client-side after cache lookup so the cache stays
 * shared across filtered + unfiltered calls within the TTL window.
 * `invalidate(projectId?)` drops one entry (or all when omitted) —
 * handlers call this after `POST /plots` and the mutating
 * `POST /plots/:id/*` endpoints land so the next list sees fresh data
 * without waiting for the TTL.
 */

import { join } from "node:path";
import type { PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import type { ProjectRow } from "../db/schema.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import type { Logger } from "../server/types.ts";
import { buildIntentGoalPreview, type PlotSummary } from "./types.ts";

/**
 * Subset of `UserPlotClient` the aggregator actually exercises. Carved
 * as an interface so unit tests can stub without touching disk — see
 * `aggregate.test.ts`. Mirrors the seam shape from
 * `SpawnPlotAppender` / `PlanRunPlotAppender`.
 */
export interface AggregatorPlotClient {
	query(): Promise<{ rows: ReadonlyArray<{ id: string }> }>;
	rebuildIndex(): Promise<void>;
	readPlot(plotId: string): Promise<{
		name: string;
		status: PlotStatus;
		updated_at: string;
		intent: { goal: string };
		attachments: ReadonlyArray<unknown>;
	}>;
	readEvents(plotId: string): Promise<ReadonlyArray<PlotEvent>>;
	close(): void;
}

/**
 * Factory that opens a per-project `AggregatorPlotClient`. The default
 * (`defaultAggregatorClientFactory`) wraps `UserPlotClient` against
 * `<project.localPath>/.plot/`. Tests inject a stub here.
 */
export type AggregatorClientFactory = (project: ProjectRow) => AggregatorPlotClient;

export const defaultAggregatorClientFactory: AggregatorClientFactory = (project) => {
	const client = new UserPlotClient({
		dir: join(project.localPath, ".plot"),
		actor: { kind: "user", handle: "operator", raw: "user:operator" },
	});
	return {
		async query() {
			return client.query();
		},
		async rebuildIndex() {
			await client.rebuildIndex();
		},
		async readPlot(plotId) {
			const plot = await client.get(plotId).read();
			return plot;
		},
		async readEvents(plotId) {
			return client.get(plotId).events();
		},
		close() {
			client.close();
		},
	};
};

export interface PlotAggregatorOptions {
	readonly projectsRepo: { listAll(): Promise<ProjectRow[]> };
	readonly logger: Logger;
	readonly clientFactory?: AggregatorClientFactory;
	/** Cache TTL in ms. Default 5000 per the seed spec. */
	readonly cacheTtlMs?: number;
	/** Clock seam; defaults to `Date.now`. */
	readonly now?: () => number;
}

export interface ListPlotSummariesQuery {
	readonly status?: PlotStatus;
}

export interface PlotAggregator {
	/**
	 * Aggregate `PlotSummary` rows across every `hasPlot=true` project.
	 * Sorted by `last_event_ts` desc. Returns the canonical `EMPTY`
	 * reference when no project has `hasPlot=true` (byte-identical
	 * contract — see module comment).
	 */
	listSummaries(q?: ListPlotSummariesQuery): Promise<readonly PlotSummary[]>;
	/**
	 * Drop one project's cache entry (or all entries when omitted).
	 * Called by mutating handlers so the next read sees fresh data.
	 */
	invalidate(projectId?: string): void;
}

/**
 * The frozen empty array returned when no project has `hasPlot=true`.
 * Pinned as the byte-identical reference (and pinned by tests) so a
 * standalone-warren deployment without Plot in use sees a stable JSON
 * body — `JSON.stringify([])` is byte-identical regardless, but
 * keeping the reference identical lets call sites do reference equality
 * checks (e.g. handler-level short-circuit metrics).
 */
export const EMPTY_PLOT_SUMMARIES: readonly PlotSummary[] = Object.freeze([]);

interface CacheEntry {
	readonly summaries: readonly PlotSummary[];
	readonly expiresAt: number;
}

export function createPlotAggregator(opts: PlotAggregatorOptions): PlotAggregator {
	const factory = opts.clientFactory ?? defaultAggregatorClientFactory;
	const ttl = opts.cacheTtlMs ?? 5_000;
	const now = opts.now ?? (() => Date.now());
	const cache = new Map<string, CacheEntry>();

	async function loadProject(project: ProjectRow): Promise<readonly PlotSummary[]> {
		const cached = cache.get(project.id);
		if (cached !== undefined && cached.expiresAt > now()) {
			return cached.summaries;
		}
		const summaries = await fetchProjectSummaries(project, factory, opts.logger);
		cache.set(project.id, { summaries, expiresAt: now() + ttl });
		return summaries;
	}

	return {
		async listSummaries(q) {
			const projects = await opts.projectsRepo.listAll();
			const plotProjects = projects.filter((p) => p.hasPlot);
			if (plotProjects.length === 0) {
				// Byte-identical empty-deployments contract (seed acceptance).
				return EMPTY_PLOT_SUMMARIES;
			}
			const perProject = await Promise.all(plotProjects.map((p) => loadProject(p)));
			const merged: PlotSummary[] = [];
			for (const list of perProject) {
				for (const s of list) {
					if (q?.status !== undefined && s.status !== q.status) continue;
					merged.push(s);
				}
			}
			merged.sort((a, b) => {
				if (a.last_event_ts === b.last_event_ts) return a.id.localeCompare(b.id);
				return a.last_event_ts < b.last_event_ts ? 1 : -1;
			});
			return merged;
		},
		invalidate(projectId) {
			if (projectId === undefined) {
				cache.clear();
				return;
			}
			cache.delete(projectId);
		},
	};
}

/**
 * Per-project fetch: query the index (retrying once after `rebuildIndex`
 * on first-attempt failure — mx-239786 pattern), then load each Plot +
 * its event tail in parallel. On total per-project failure logs a
 * `plots.aggregate_project_failed` warning and returns an empty array
 * so one broken `.plot/` doesn't 500 the deployment-wide list.
 */
async function fetchProjectSummaries(
	project: ProjectRow,
	factory: AggregatorClientFactory,
	logger: Logger,
): Promise<readonly PlotSummary[]> {
	const client = factory(project);
	try {
		const rows = await queryWithRebuildRetry(client);
		if (rows.length === 0) return [];
		const summaries = await Promise.all(
			rows.map(async (row) => {
				const [plot, events] = await Promise.all([
					client.readPlot(row.id),
					client.readEvents(row.id),
				]);
				const tail = events.length > 0 ? events[events.length - 1] : undefined;
				const summary: PlotSummary = {
					id: row.id,
					name: plot.name,
					status: plot.status,
					intent_goal_preview: buildIntentGoalPreview(plot.intent.goal),
					attachments_count: plot.attachments.length,
					last_event_ts: tail?.at ?? plot.updated_at,
					last_event_actor: tail?.actor ?? "",
					project_id: project.id,
				};
				return summary;
			}),
		);
		return summaries;
	} catch (err) {
		logger.warn(
			{
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"plots.aggregate_project_failed",
		);
		return [];
	} finally {
		try {
			client.close();
		} catch {
			// best-effort
		}
	}
}

async function queryWithRebuildRetry(
	client: AggregatorPlotClient,
): Promise<ReadonlyArray<{ id: string }>> {
	try {
		const r = await client.query();
		return r.rows;
	} catch (err) {
		try {
			await client.rebuildIndex();
		} catch {
			// rebuild is best-effort recovery; if it fails we still retry
			// the query once so the original error wins.
		}
		try {
			const r = await client.query();
			return r.rows;
		} catch {
			throw err;
		}
	}
}
