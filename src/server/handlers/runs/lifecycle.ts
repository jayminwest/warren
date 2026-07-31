import { ValidationError } from "../../../core/errors.ts";
import type { RunRow } from "../../../db/schema.ts";
import { readProviderFrontmatter } from "../../../registry/index.ts";
import {
	buildCostAnalytics,
	type CostAnalyticsRow,
	hydrateRunsUsage,
	hydrateRunUsage,
} from "../../../runs/index.ts";
import { isPublicOnly, pickFields } from "../../projection.ts";
import { jsonResponse } from "../../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";

/**
 * The run columns a `readPublic`-only spectator sees (warren-946f /
 * pl-b82d step 14). An allowlist, so a column added to `runs` tomorrow is
 * absent from the public body until someone classifies it here — see
 * `src/server/projection.ts` for why this is never a denylist.
 *
 * The prompt stays: "here's what we asked, here's what it did" is the
 * interesting half of a public instance. Per-run `costUsd` and the token
 * counts stay too — cost-per-merged-PR is the metric the instance exists
 * to show, and it is os-eco's own spend on its own public repos.
 */
export const PUBLIC_RUN_FIELDS = [
	"id",
	"agentName",
	"projectId",
	"seedId",
	"parentRunId",
	"cloneKind",
	"mode",
	"state",
	"failureReason",
	"startedAt",
	"endedAt",
	"prompt",
	"trigger",
	"prUrl",
	"targetBranch",
	// warren-cd3b: the rescue ref is operator-recovery metadata (a branch name
	// carrying the run id, which is already public) — safe for spectators.
	"salvageRef",
	"costUsd",
	"tokensInput",
	"tokensOutput",
	"tokensCacheRead",
	"tokensCacheWrite",
	"previewState",
	"previewPort",
	"previewStartedAt",
	"previewLastHitAt",
] as const satisfies readonly (keyof RunRow)[];

/**
 * The complement of `PUBLIC_RUN_FIELDS`, spelled out so the classification
 * is a decision on record rather than "whatever fell off the list", and so
 * `lifecycle.projection.test.ts` can assert the two partition `RunRow`.
 *
 * - `renderedAgentJson` — the fully rendered system prompt. Prompt
 *   engineering is the IP here, and it is pure noise to a spectator.
 * - `burrowId` / `burrowRunId` / `workerId` — internal runtime handles.
 *   They also render as empty "—" cards on the K8s instance today.
 * - `previewFailureMessage` — free text carrying a subprocess stderr tail.
 * - `salvagePath` — a host filesystem path (warren-cd3b); internal topology,
 *   same posture as the runtime handles.
 */
export const REDACTED_RUN_FIELDS = [
	"renderedAgentJson",
	"burrowId",
	"burrowRunId",
	"workerId",
	"previewFailureMessage",
	"salvagePath",
] as const satisfies readonly (keyof RunRow)[];

/** A run row as a `readPublic`-only caller sees it. */
export type PublicRun = Pick<RunRow, (typeof PUBLIC_RUN_FIELDS)[number]>;

/**
 * Narrow one run row for `actor`. The operator gets the row untouched, so
 * the public body is provably the operator body minus fields — there is
 * only one construction site and the two cannot drift.
 *
 * Exported (warren-c405) because `GET /plan-runs/:id` fans out `runs[]` too
 * and must reuse THIS function rather than grow a second projection: the
 * plan-run detail handler served raw `RunRow`s to spectators until scenario
 * 39 caught it.
 */
export function projectRun<T extends RunRow>(run: T, actor: Actor | undefined): T | PublicRun {
	return isPublicOnly(actor) ? pickFields(run, PUBLIC_RUN_FIELDS) : run;
}

function parseRunsSort(ctx: { url: URL }): { sort: "started" | "cost"; dir: "asc" | "desc" } {
	const rawSort = ctx.url.searchParams.get("sort");
	const rawDir = ctx.url.searchParams.get("dir");
	let sort: "started" | "cost" = "started";
	if (rawSort !== null) {
		if (rawSort !== "started" && rawSort !== "cost") {
			throw new ValidationError(`?sort must be 'started' or 'cost'; got '${rawSort}'`);
		}
		sort = rawSort;
	}
	let dir: "asc" | "desc" = "desc";
	if (rawDir !== null) {
		if (rawDir !== "asc" && rawDir !== "desc") {
			throw new ValidationError(`?dir must be 'asc' or 'desc'; got '${rawDir}'`);
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
		const hydrated = await hydrateRunsUsage(rows, deps.repos.events);
		// warren-ee50 / pl-b0c0 step 1: aggregate the full filtered set so
		// the Runs page can show all-time totals next to a paginated table.
		const aggFilter = {
			...(project !== null ? { projectId: project } : {}),
			...(agent !== null ? { agentName: agent } : {}),
		};
		const agg = await deps.repos.runs.aggregate(aggFilter);
		// warren-946f: `costTotalUsd` is an instance-wide all-time number.
		// Unlabeled on a list endpoint it reads as a headline out of
		// context, so it belongs in a deliberately framed ledger view
		// rather than here; per-run `costUsd` survives the projection.
		const publicOnly = isPublicOnly(ctx.actor);
		return jsonResponse(200, {
			runs: hydrated.map((run) => projectRun(run, ctx.actor)),
			total: agg.total,
			...(publicOnly ? {} : { costTotalUsd: agg.costTotalUsd }),
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
		return jsonResponse(200, projectRun(run, ctx.actor));
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
		const defaultFrom = resolveAnalyticsFrom(from, to);
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

export function parseAnalyticsDateBound(
	ctx: { url: URL },
	name: "from" | "to",
): string | undefined {
	const raw = ctx.url.searchParams.get(name);
	if (raw === null || raw === "") return undefined;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		throw new ValidationError(`?${name} must be an ISO8601 date or datetime`);
	}
	return d.toISOString();
}

/**
 * Resolve the analytics window `from` bound, defaulting to the last 30
 * days when neither bound is supplied so a fresh install renders a
 * useful chart without operator setup. Shared by the cost + run
 * analytics handlers (warren-cf63 / warren-0692).
 */
export function resolveAnalyticsFrom(
	from: string | undefined,
	to: string | undefined,
): string | undefined {
	if (from !== undefined) return from;
	if (to !== undefined) return undefined;
	return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function extractProviderModel(rendered: unknown): { provider?: string; model?: string } {
	if (rendered === null || typeof rendered !== "object") return {};
	const fm = (rendered as { frontmatter?: unknown }).frontmatter;
	if (fm === null || fm === undefined || typeof fm !== "object") return {};
	return readProviderFrontmatter(fm as Readonly<Record<string, unknown>>);
}
