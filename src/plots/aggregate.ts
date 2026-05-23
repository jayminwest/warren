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
 * query is retried once. The retry also fires when the first query
 * returns zero rows *and* `.plot/` has at least one `*.json` file on
 * disk (warren-ede7): `.plot/.index.db` is gitignored, so a freshly
 * refreshed clone has the JSON files but no index DB, and
 * `SQLitePlotIndex` creates an empty index on first construction
 * without throwing. The disk probe distinguishes "index is stale,
 * rebuild" from "project legitimately has no plots" so the rebuild
 * cost only lands when there's actually something to recover (the
 * index is reconstructible from the JSON files at any time — Plot
 * SPEC §4.1).
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

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import type { ProjectRow, RunRow } from "../db/schema.ts";
import { UserPlotClient } from "../plot-client/index.ts";
import type { Logger } from "../server/types.ts";
import {
	computeNeedsAttentionReasons,
	DEFAULT_STALE_DRAFT_DAYS,
	type NeedsAttentionReason,
} from "./needs-attention.ts";
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
	/**
	 * Probe whether the project's `.plot/` directory contains at least
	 * one non-dot `*.json` Plot file on disk. Used by
	 * `queryWithRebuildRetry` to distinguish "index is stale, rebuild"
	 * from "project legitimately has no plots" when the first query
	 * returns empty rows without throwing — the case a freshly-refreshed
	 * clone hits because `.index.db` is gitignored (warren-ede7).
	 */
	hasPlotFilesOnDisk(): Promise<boolean>;
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
	const dir = join(project.localPath, ".plot");
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "operator", raw: "user:operator" },
	});
	return {
		async query() {
			return client.query();
		},
		async rebuildIndex() {
			await client.rebuildIndex();
		},
		async hasPlotFilesOnDisk() {
			try {
				const entries = await readdir(dir);
				return entries.some((name) => !name.startsWith(".") && name.endsWith(".json"));
			} catch {
				return false;
			}
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

/**
 * Narrow seam over `RunsRepo` exposing only the queries the
 * needs-attention scorer requires (warren-d693 / pl-0344 step 9). The
 * aggregator calls `listByState('paused')` once per
 * `listNeedsAttention()` invocation and groups the result by `plotId`
 * — a single SQL query covers the whole deployment, not a per-Plot
 * fan-out. The default wiring in `src/server/main.ts` passes
 * `repos.runs` directly; tests pass a stub.
 */
export interface AggregatorRunsRepo {
	listByState(state: "paused"): Promise<RunRow[]>;
}

export interface PlotAggregatorOptions {
	readonly projectsRepo: { listAll(): Promise<ProjectRow[]> };
	readonly logger: Logger;
	readonly clientFactory?: AggregatorClientFactory;
	/** Cache TTL in ms. Default 5000 per the seed spec. */
	readonly cacheTtlMs?: number;
	/** Clock seam; defaults to `Date.now`. */
	readonly now?: () => number;
	/**
	 * Source for the `paused_run` needs-attention signal. Optional only
	 * so the existing fakes don't break; in production main wires
	 * `repos.runs`. When absent, `listNeedsAttention` / `countNeedsAttention`
	 * treat every Plot as having zero paused runs (the other two signals
	 * still apply).
	 */
	readonly runsRepo?: AggregatorRunsRepo;
	/**
	 * Stale-draft threshold in days for the `stale_draft`
	 * needs-attention signal (warren-d693 / pl-0344 step 9). Defaults
	 * to `DEFAULT_STALE_DRAFT_DAYS` (7). Tests shrink this to make
	 * deterministic assertions cheap.
	 */
	readonly staleDraftAfterDays?: number;
}

export interface ListPlotSummariesQuery {
	readonly status?: PlotStatus;
}

/**
 * `PlotSummary` plus the ordered list of reasons it surfaces in the
 * "Needs you" view (warren-d693 / pl-0344 step 9). Returned by
 * `PlotAggregator.listNeedsAttention()` and the `?filter=needs_attention`
 * variant of `GET /plots`.
 */
export interface PlotNeedsAttentionSummary extends PlotSummary {
	readonly reasons: readonly NeedsAttentionReason[];
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
	 * Aggregate Plots that surface in the deployment-wide "Needs you"
	 * view (warren-d693 / pl-0344 step 9). Each row carries an ordered,
	 * non-empty `reasons` list. Sorted by `last_event_ts` desc, matching
	 * `listSummaries`. Returns an empty array when no Plot qualifies
	 * (and when the deployment has zero `hasPlot=true` projects).
	 *
	 * Cost model: one `listByState('paused')` query, one cached
	 * `listSummaries()` call, and per-Plot `readEvents` for every Plot
	 * already cached. The per-project cache is shared with
	 * `listSummaries`, so a UI that renders both the main Plots list
	 * and the sidebar badge within the 5s TTL only pays the events
	 * fan-out once.
	 */
	listNeedsAttention(): Promise<readonly PlotNeedsAttentionSummary[]>;
	/**
	 * Count of Plots in the "Needs you" view. Powers the sidebar badge
	 * (warren-f0e2 / pl-0344 step 13). Currently delegates to
	 * `listNeedsAttention().length`; the indirection keeps room for a
	 * cheaper per-project count cache if the badge becomes a hot path.
	 */
	countNeedsAttention(): Promise<number>;
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
	const staleDraftAfterDays = opts.staleDraftAfterDays ?? DEFAULT_STALE_DRAFT_DAYS;
	const cache = new Map<string, CacheEntry>();
	const eventsCache = new Map<string, ReadonlyArray<PlotEvent>>();

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
		async listNeedsAttention() {
			const summaries = await this.listSummaries();
			if (summaries.length === 0) return [];
			const pausedByPlot = await pausedPlotIds(opts.runsRepo, opts.logger);
			const nowDate = new Date(now());
			// Cache the project lookup once per call so loadEventsForSummary
			// doesn't hit projectsRepo.listAll() per Plot.
			const projects = await opts.projectsRepo.listAll();
			const projectsById = new Map(projects.map((p) => [p.id, p]));
			const rows: PlotNeedsAttentionSummary[] = [];
			for (const s of summaries) {
				const events = await loadEventsForSummary(s, projectsById);
				const reasons = computeNeedsAttentionReasons({
					plot: s,
					events,
					hasPausedRun: pausedByPlot.has(s.id),
					now: nowDate,
					staleDraftAfterDays,
				});
				if (reasons.length > 0) {
					rows.push({ ...s, reasons });
				}
			}
			return rows;
		},
		async countNeedsAttention() {
			const rows = await this.listNeedsAttention();
			return rows.length;
		},
		invalidate(projectId) {
			if (projectId === undefined) {
				cache.clear();
				eventsCache.clear();
				return;
			}
			cache.delete(projectId);
			// Drop any cached events whose Plot belonged to this project.
			// We can't tell from a Plot id alone which project it came from,
			// so just clear all events on per-project invalidation. The
			// events cache is a within-call optimisation anyway (see
			// `loadEventsForSummary`), so the throwaway cost is bounded.
			eventsCache.clear();
		},
	};

	async function loadEventsForSummary(
		summary: PlotSummary,
		projectsById: Map<string, ProjectRow>,
	): Promise<ReadonlyArray<PlotEvent>> {
		const cached = eventsCache.get(summary.id);
		if (cached !== undefined) return cached;
		const project = projectsById.get(summary.project_id);
		if (project === undefined) return [];
		const client = factory(project);
		try {
			const events = await client.readEvents(summary.id);
			eventsCache.set(summary.id, events);
			return events;
		} catch (err) {
			opts.logger.warn(
				{
					plotId: summary.id,
					projectId: summary.project_id,
					err: err instanceof Error ? err.message : String(err),
				},
				"plots.needs_attention_events_failed",
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
}

/**
 * Build the `plotId → hasPaused` lookup used by the needs-attention
 * scorer. Tolerates an absent `runsRepo` (treats no rows as paused) and
 * a failing query (logs + returns empty so one broken backend doesn't
 * 500 the deployment-wide list). Rows with `plotId === null` are
 * skipped — those are batch runs not tied to a Plot.
 */
async function pausedPlotIds(
	runsRepo: AggregatorRunsRepo | undefined,
	logger: Logger,
): Promise<Set<string>> {
	if (runsRepo === undefined) return new Set();
	try {
		const rows = await runsRepo.listByState("paused");
		const set = new Set<string>();
		for (const row of rows) {
			if (row.plotId !== null && row.plotId !== undefined && row.plotId !== "") {
				set.add(row.plotId);
			}
		}
		return set;
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"plots.needs_attention_paused_query_failed",
		);
		return new Set();
	}
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
		if (r.rows.length === 0) {
			// Cold-cache empty-rows path (warren-ede7): `.plot/.index.db`
			// is gitignored, so a freshly-refreshed clone has the *.json
			// files but no index DB. SQLitePlotIndex creates an empty
			// index on first construction without throwing, so query()
			// returns empty rather than failing. Probe disk to tell that
			// case apart from a project that legitimately has no plots
			// — only the former should pay a rebuild cost.
			const hasFiles = await client.hasPlotFilesOnDisk();
			if (!hasFiles) return r.rows;
			try {
				await client.rebuildIndex();
			} catch {
				return r.rows;
			}
			const retry = await client.query();
			return retry.rows;
		}
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
