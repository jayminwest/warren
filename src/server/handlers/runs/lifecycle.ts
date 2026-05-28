import { ValidationError } from "../../../core/errors.ts";
import { readProviderFrontmatter } from "../../../registry/index.ts";
import {
	buildCostAnalytics,
	type CostAnalyticsRow,
	hydrateRunsUsage,
	hydrateRunUsage,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";

function parseRunsSort(ctx: { url: URL }): { sort: "started" | "cost"; dir: "asc" | "desc" } {
	const rawSort = ctx.url.searchParams.get("sort");
	const rawDir = ctx.url.searchParams.get("dir");
	let sort: "started" | "cost" = "started";
	if (rawSort !== null) {
		if (rawSort !== "started" && rawSort !== "cost") {
			throw new ValidationError("?sort must be 'started' or 'cost'");
		}
		sort = rawSort;
	}
	let dir: "asc" | "desc" = "desc";
	if (rawDir !== null) {
		if (rawDir !== "asc" && rawDir !== "desc") {
			throw new ValidationError("?dir must be 'asc' or 'desc'");
		}
		dir = rawDir;
	}
	return { sort, dir };
}

/**
 * Parse `?limit` / `?offset` for the runs list (warren-ee50 / pl-b0c0
 * step 1). Defaults preserve the historical 100-row window so existing
 * consumers stay byte-compatible; `limit` is clamped to a sane range
 * to keep a paginated UI honest and the server cheap. `offset` is
 * non-negative; the caller is responsible for stitching pages on its
 * end (no opaque cursor — the predicates here are stable + the
 * `runs.id` tiebreaker in `orderByClause` keeps the order total).
 */
function parseRunsPagination(ctx: { url: URL }): { limit: number; offset: number } {
	const rawLimit = ctx.url.searchParams.get("limit");
	const rawOffset = ctx.url.searchParams.get("offset");
	let limit = 100;
	if (rawLimit !== null) {
		const n = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(n) || n <= 0 || String(n) !== rawLimit) {
			throw new ValidationError(`?limit must be a positive integer; got '${rawLimit}'`);
		}
		if (n > 500) throw new ValidationError("?limit must be ≤ 500");
		limit = n;
	}
	let offset = 0;
	if (rawOffset !== null) {
		const n = Number.parseInt(rawOffset, 10);
		if (!Number.isFinite(n) || n < 0 || String(n) !== rawOffset) {
			throw new ValidationError(`?offset must be a non-negative integer; got '${rawOffset}'`);
		}
		offset = n;
	}
	return { limit, offset };
}

export function listRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const agent = ctx.url.searchParams.get("agent");
		if (project !== null && agent !== null) {
			throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
		}
		const order = parseRunsSort(ctx);
		const page = parseRunsPagination(ctx);
		const listOpts = { ...order, ...page };
		const rows =
			project !== null
				? await deps.repos.runs.listByProject(project, listOpts)
				: agent !== null
					? await deps.repos.runs.listByAgent(agent, listOpts)
					: await deps.repos.runs.listAll(listOpts);
		// warren-ab18: surface in-events cost for terminal runs whose
		// bridge died before the final checkpoint landed.
		const runs = await hydrateRunsUsage(rows, deps.repos.events);
		// warren-ee50 / pl-b0c0 step 1: aggregate the full filtered set so
		// the Runs page can show all-time totals next to a paginated table.
		const aggFilter = {
			...(project !== null ? { projectId: project } : {}),
			...(agent !== null ? { agentName: agent } : {}),
		};
		const agg = await deps.repos.runs.aggregate(aggFilter);
		return jsonResponse(200, {
			runs,
			total: agg.total,
			costTotalUsd: agg.costTotalUsd,
			costPricedCount: agg.costPricedCount,
			limit: page.limit,
			offset: page.offset,
		});
	};
}

export function getRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await deps.repos.runs.require(id);
		// warren-ab18: same compute-on-read fallback as the list handler
		// so the RunDetail page shows cost for ghost / reboot-orphaned runs.
		const run = await hydrateRunUsage(row, deps.repos.events);
		return jsonResponse(200, run);
	};
}

/**
 * `GET /analytics/cost?from=&to=&projectId=` (warren-cf63 / pl-b0c0 step 6).
 *
 * Window defaults to the last 30 days when neither bound is supplied so
 * a fresh install renders a useful chart without operator setup. Both
 * bounds and `projectId` are validated lightly — a malformed date is a
 * 400 because the lexicographic ISO8601 compare in `listForAnalytics`
 * would silently produce surprising results otherwise.
 */
export function listCostAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = ctx.url.searchParams.get("projectId") ?? undefined;
		const from = parseAnalyticsDateBound(ctx, "from");
		const to = parseAnalyticsDateBound(ctx, "to");
		const defaultFrom = (() => {
			if (from !== undefined) return from;
			if (to !== undefined) return undefined;
			const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
			return d.toISOString();
		})();
		const filter: { projectId?: string; from?: string; to?: string } = {};
		if (projectId !== undefined) filter.projectId = projectId;
		if (defaultFrom !== undefined) filter.from = defaultFrom;
		if (to !== undefined) filter.to = to;
		const rowsRaw = await deps.repos.runs.listForAnalytics(filter);
		// Hydrate so terminal runs with bridge-died cost still count.
		const rows = await hydrateRunsUsage(rowsRaw, deps.repos.events);
		const planByRun = new Map<string, string>();
		if (rows.length > 0) {
			const joined = await deps.repos.planRuns.resolvePlanForRunIds(rows.map((r) => r.id));
			for (const j of joined) planByRun.set(j.runId, j.planId);
		}
		const analyticsRows: CostAnalyticsRow[] = rows.map((r) => {
			const { provider, model } = extractProviderModel(r.renderedAgentJson);
			return {
				runId: r.id,
				projectId: r.projectId,
				agentName: r.agentName,
				plotId: r.plotId,
				planId: planByRun.get(r.id) ?? null,
				planRunId: null,
				provider: provider ?? null,
				model: model ?? null,
				costUsd: r.costUsd,
				startedAt: r.startedAt,
			};
		});
		const analytics = buildCostAnalytics(analyticsRows);
		return jsonResponse(200, {
			filter: {
				projectId: projectId ?? null,
				from: defaultFrom ?? null,
				to: to ?? null,
			},
			...analytics,
		});
	};
}

function parseAnalyticsDateBound(ctx: { url: URL }, name: "from" | "to"): string | undefined {
	const raw = ctx.url.searchParams.get(name);
	if (raw === null || raw === "") return undefined;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		throw new ValidationError(`?${name} must be an ISO8601 date or datetime`);
	}
	return d.toISOString();
}

function extractProviderModel(rendered: unknown): { provider?: string; model?: string } {
	if (rendered === null || typeof rendered !== "object") return {};
	const fm = (rendered as { frontmatter?: unknown }).frontmatter;
	if (fm === null || fm === undefined || typeof fm !== "object") return {};
	return readProviderFrontmatter(fm as Readonly<Record<string, unknown>>);
}
