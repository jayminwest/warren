/**
 * Run + run-preview HTTP handlers (warren-a2b4 / pl-9088 step 2).
 *
 * Extracted from `src/server/handlers/index.ts`. The shared parsing
 * helpers (`readJsonBody`, `readJsonBodyOrEmpty`, `requireString`,
 * `optionalString`, `requireParam`, `parseBoolean`, `parseNonNegativeInt`,
 * `assertPlotIdDispatchable`, `defaultSpawn`) are re-imported from the
 * index module so the wire contract stays byte-identical across the
 * split. Streaming plumbing (`bridgeAbort`, `asNdjsonStream`,
 * `eventToNdjson`) lives here and is re-exported for the plan-run
 * stream handler in `./plan-runs.ts`.
 */

import { join } from "node:path";
import type { MessagePriority } from "@os-eco/burrow-cli";
import { ValidationError } from "../../core/errors.ts";
import { createRunPreviewsRepo } from "../../preview/eviction.ts";
import { teardownPreview } from "../../preview/teardown.ts";
import { readProviderFrontmatter } from "../../registry/index.ts";
import {
	appendUserMessage,
	buildCostAnalytics,
	buildInteractivePrompt,
	type CostAnalyticsRow,
	cancelRun,
	defaultPlotContextReader,
	hydrateRunsUsage,
	hydrateRunUsage,
	resolveDispatcherHandle,
	spawnInteractiveTurn,
	spawnRun,
	steerRun,
	tailRunEvents,
} from "../../runs/index.ts";
import { jsonResponse, ndjsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import {
	assertPlotIdDispatchable,
	defaultSpawn,
	optionalString,
	parseBoolean,
	parseNonNegativeInt,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "./index.ts";

/* ----------------------------------------------------------------------- */
/* Runs (§8.1)                                                              */
/* ----------------------------------------------------------------------- */

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

/**
 * Parse the optional `mode` body field on `POST /runs` (pl-0344 step 4 /
 * warren-b3b9). Defaults to `'batch'` so existing single-shot dispatch
 * callers are byte-identical. `'interactive'` opts in to the
 * respawn-per-turn primitive (`src/runs/interactive.ts`); when set,
 * `plotId` is required and `interactiveAgent` may override `agent`.
 */
function parseRunMode(body: Record<string, unknown>): "batch" | "interactive" {
	const raw = body.mode;
	if (raw === undefined || raw === null) return "batch";
	if (raw !== "batch" && raw !== "interactive") {
		throw new ValidationError(
			`field 'mode' must be 'batch' or 'interactive'; got ${JSON.stringify(raw)}`,
		);
	}
	return raw;
}

export function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const mode = parseRunMode(body);
		const ref = optionalString(body, "ref");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const seedId = optionalString(body, "seedId");
		const plotId = optionalString(body, "plotId");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		// `interactiveAgent` overrides `agent` when mode='interactive' (pl-0344
		// step 4 / warren-b3b9). The field is dedicated so a UI surface that
		// always sends both `agent` (batch default) and `interactiveAgent`
		// (brainstorm/planner preset) can flip mode without re-keying.
		const interactiveAgent = optionalString(body, "interactiveAgent");
		const agentName =
			mode === "interactive" && interactiveAgent !== undefined
				? interactiveAgent
				: requireString(body, "agent");
		const projectId = requireString(body, "project");
		const prompt = requireString(body, "prompt");

		// warren-bae5 / pl-5310 step 2: validate plot_id BEFORE handing off
		// to spawnRun so a malformed or non-existent plot_id fails at the
		// operator-facing edge instead of silently no-opping at the
		// host-side defaultPlotAppender. Empty string is normalized to "no
		// plot bound" (matches spawnRun's posture and the createPlanRun gate).
		await assertPlotIdDispatchable({ plotId, plotResolver: deps.plotResolver });

		// Interactive runs REQUIRE a plot_id — the primitive is meaningless
		// without a Plot to bind the conversation to. Validated AFTER format
		// + existence so the more-specific format error still wins when both
		// apply.
		if (mode === "interactive" && (plotId === undefined || plotId === "")) {
			throw new ValidationError(
				"plotId is required when mode='interactive'; interactive runs bind to a Plot",
				{
					recoveryHint: "either pass plotId on POST /runs, or omit `mode` to dispatch a batch run",
				},
			);
		}

		// Compose the dispatch prompt. Batch runs ship the operator-supplied
		// prompt verbatim. Interactive first-turn dispatches wrap it in the
		// same <plot_context> + <user_message> envelope the follow-up turn
		// builder (`spawnInteractiveTurn`) emits, so the agent sees a uniform
		// prompt shape across turn 1 and turn N. Context load is best-effort
		// — a torn `.plot/.index.db` or vanished events file falls back to
		// the user message alone.
		let dispatchedPrompt = prompt;
		if (mode === "interactive" && plotId !== undefined && plotId !== "") {
			const project = await deps.repos.projects.require(projectId);
			const handle = resolveDispatcherHandle(dispatcherHandle);
			let context = null;
			try {
				context = await defaultPlotContextReader.read({
					plotDir: join(project.localPath, ".plot"),
					plotId,
					historyTail: 0,
					handle,
				});
			} catch {
				// Best-effort — first-turn dispatches still proceed without
				// the envelope. spawnInteractiveTurn captures the same
				// degradation as a system event; on first turn we don't yet
				// have a run row to attach the warning to.
			}
			dispatchedPrompt = buildInteractivePrompt(context, prompt);
		}

		const result = await spawnRun({
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName,
			projectId,
			prompt: dispatchedPrompt,
			mode,
			...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(seedId !== undefined ? { seedId } : {}),
			...(plotId !== undefined ? { plotId } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		});

		// First-turn interactive dispatch: append the raw user_message event
		// onto the new run so the events stream reflects the conversation
		// from turn 0. `spawnInteractiveTurn` (follow-up turns) does the same.
		if (mode === "interactive") {
			await appendUserMessage({
				repos: deps.repos,
				runId: result.run.id,
				message: prompt,
				handle: resolveDispatcherHandle(dispatcherHandle),
				...(deps.now !== undefined ? { now: deps.now() } : {}),
			});
		}

		// Hand off to the bridge so events start flowing into warren.events
		// — without this the dispatched run would emit events into burrow
		// but the warren wire would never see them.
		deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return jsonResponse(201, {
			run: result.run,
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

/**
 * `POST /runs/:id/messages` — send a follow-up user turn on an
 * interactive conversation (pl-0344 step 4 / warren-b3b9).
 *
 * `:id` is the conversation handle — any prior interactive run row that
 * shares the same plotId works (the handler resolves the plot context
 * from disk, not from this row). Returns **202 Accepted** with the
 * freshly-spawned turn row + burrow descriptor + user_message event:
 * the dispatch is async (the agent reply lands later as an
 * `agent_message` event captured at reap), and 202 is the canonical
 * "queued for processing, see events stream for completion" shape.
 *
 * Body: `{message: string, dispatcherHandle?: string, providerOverride?,
 * modelOverride?, ref?}`. Field shape mirrors `POST /runs` so a UI
 * surface can reuse its dispatch plumbing.
 *
 * Errors:
 *   - 400 `validation_error` — missing/empty message, prior run is not
 *     mode='interactive', prior run has no plot_id, message is empty.
 *   - 404 `not_found` — prior run id doesn't exist.
 *
 * The follow-up turn is registered with the bridge the same way `POST
 * /runs` does, so its events flow onto warren's stream immediately.
 */
export function postRunMessageHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const message = requireString(body, "message");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const ref = optionalString(body, "ref");

		const result = await spawnInteractiveTurn({
			runId: id,
			message,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			trigger: "interactive",
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			...(ref !== undefined ? { ref } : {}),
			...(providerOverride !== undefined ? { providerOverride } : {}),
			...(modelOverride !== undefined ? { modelOverride } : {}),
			...(dispatcherHandle !== undefined ? { dispatcherHandle } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
			...(deps.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: deps.runBranchPrefixDefault }
				: {}),
			...(deps.seedsCli !== undefined ? { seedsCli: deps.seedsCli } : {}),
		});

		deps.bridges.start(result.turn.run.id, result.turn.burrowRun.id, result.turn.burrow.id);

		return jsonResponse(202, {
			run: result.turn.run,
			burrow: {
				id: result.turn.burrow.id,
				workspacePath: result.turn.burrow.workspacePath,
			},
			userMessageEvent: {
				id: result.userMessageEvent.id,
				runId: result.userMessageEvent.runId,
				seq: result.userMessageEvent.burrowEventSeq,
				ts: result.userMessageEvent.ts,
				kind: result.userMessageEvent.kind,
			},
			priorRunId: result.priorRun.id,
			plotContextDegraded: result.plotContextDegraded,
		});
	};
}

export function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(optionalString(body, "priority") !== undefined
				? { priority: optionalString(body, "priority") as MessagePriority }
				: {}),
			...(optionalString(body, "fromActor") !== undefined
				? { fromActor: optionalString(body, "fromActor") as string }
				: {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { message: result.message });
	};
}

export function cancelRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const reason = body !== null ? optionalString(body, "reason") : undefined;
		const result = await cancelRun({
			runId: id,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(reason !== undefined ? { reason } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
		});
		return jsonResponse(200, {
			state: result.state,
			alreadyTerminal: result.alreadyTerminal,
			burrowRun: result.burrowRun,
		});
	};
}

/**
 * `GET /runs/:id/preview/login?token=<bearer>&redirect=<absolute-url>`
 * (R-19 / SPEC §11.L, warren-8a10; path-mode redirect warren-edff;
 * per-run cookie name warren-63e1).
 *
 * The signed-cookie handshake the preview proxy depends on. A browser
 * hitting a preview origin directly can't carry an Authorization header,
 * so the operator opens this URL on the warren host, the handler
 * validates the bearer in the query, sets a scoped `warren_preview*`
 * cookie, and 302s to the preview.
 *
 *   - **Subdomain mode** (`deps.previewMode === "subdomain"`): cookie name
 *     `warren_preview`, `Domain=.<host>; Path=/`; redirect must be
 *     `https://run-<id>.<previewHost>/...`.
 *   - **Path mode** (default; `deps.previewMode === "path"`): cookie name
 *     `warren_preview_<runId>` (per-run literal suffix, warren-63e1),
 *     `Path=/` with no `Domain`; redirect must be same-origin as the
 *     inbound request and live under `/p/<id>/`. The cookie ships on
 *     every same-origin request so referer-based asset routing in the
 *     proxy preamble can authenticate sub-resource loads.
 *
 * This route is auth-exempt (`isAuthExempt` whitelists `/preview/login`)
 * because the standard bearer gate would 401 the browser before the
 * handler ever ran. The handler does its own bearer check via
 * `previewAuth.verifyLoginToken` (constant-time compare against the
 * configured `WARREN_API_TOKEN`).
 *
 * `redirect` is constrained to the run's own preview surface — anything
 * else is rejected so a stolen login link can't become an open redirect.
 *
 * 400 when `previewAuth` is null (subdomain mode with no host, or
 * warren booted with `--no-auth`); the proxy is also disabled in those
 * configurations so the handshake has nothing to issue against.
 */
export function previewLoginHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const mode: "subdomain" | "path" = deps.previewMode ?? "subdomain";
		if (deps.previewAuth === undefined) {
			throw new ValidationError("preview surface is not configured on this warren", {
				recoveryHint:
					"ensure WARREN_API_TOKEN is set (and WARREN_PREVIEW_HOST when WARREN_PREVIEW_MODE=subdomain) to enable per-run previews",
			});
		}
		if (mode === "subdomain" && deps.previewHost === undefined) {
			throw new ValidationError("preview surface is not configured on this warren", {
				recoveryHint:
					"set WARREN_PREVIEW_HOST to enable subdomain-mode previews, or switch to WARREN_PREVIEW_MODE=path",
			});
		}
		const token = ctx.url.searchParams.get("token");
		if (!deps.previewAuth.verifyLoginToken(token)) {
			return jsonResponse(401, {
				error: {
					code: "unauthorized",
					message: "preview login requires a valid ?token=<WARREN_API_TOKEN>",
				},
			});
		}
		// 404 fast if the run isn't known — issuing a cookie for a nonexistent
		// run would let an attacker pre-seed a session keyed off a future id.
		await deps.repos.runs.require(runId);

		const redirect = ctx.url.searchParams.get("redirect");
		const redirectTarget =
			mode === "path"
				? resolvePathPreviewRedirect(redirect, runId, ctx.url.origin)
				: resolveSubdomainPreviewRedirect(redirect, runId, deps.previewHost as string);
		if (redirectTarget === null) {
			const hint =
				mode === "path"
					? `redirect must be a same-origin URL under ${ctx.url.origin}/p/${runId}/`
					: `redirect must be an absolute URL under https://run-${runId}.${deps.previewHost}/`;
			return jsonResponse(400, {
				error: {
					code: "preview_redirect_invalid",
					message: hint,
				},
			});
		}

		const now = deps.now?.() ?? new Date();
		const cookie = deps.previewAuth.signCookie(runId, now);
		return new Response(null, {
			status: 302,
			headers: {
				location: redirectTarget,
				"set-cookie": cookie.setCookieHeader,
			},
		});
	};
}

function resolveSubdomainPreviewRedirect(
	raw: string | null,
	runId: string,
	host: string,
): string | null {
	const fallback = `https://run-${runId}.${host}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.hostname !== `run-${runId}.${host}`) return null;
	return parsed.toString();
}

function resolvePathPreviewRedirect(
	raw: string | null,
	runId: string,
	inboundOrigin: string,
): string | null {
	const fallback = `${inboundOrigin}/p/${runId}/`;
	if (raw === null || raw.length === 0) return fallback;
	let parsed: URL;
	try {
		// Relative URLs (`/p/<id>/foo`) resolve against the inbound origin so
		// callers don't have to know the scheme/host upfront. Absolute URLs are
		// then origin-checked below.
		parsed = new URL(raw, inboundOrigin);
	} catch {
		return null;
	}
	if (parsed.origin !== inboundOrigin) return null;
	if (!parsed.pathname.startsWith(`/p/${runId}/`)) return null;
	return parsed.toString();
}

/**
 * `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L acceptance #8,
 * warren-d725).
 *
 * Idempotent operator-driven teardown of the per-run preview. Bearer-
 * required (the global auth gate covers `/runs/*`; this route is not
 * in `isAuthExempt`). The body is optional — `{actor}` is forwarded
 * onto the audit event for attribution, defaulting to `"manual"`.
 *
 * Responds 200 on every CAS outcome (`torn-down`, `already-torn-down`,
 * `already-failed`, `never-launched`); 404 on unknown runId; 503 when
 * `deps.db` is undefined (no repo layer wired). Works on both sqlite
 * and postgres dialects — `createRunPreviewsRepo` is dialect-
 * polymorphic (warren-adfb), so the eviction-worker CAS path that
 * teardown rides on is already exercised on pg in production. The
 * route is `tornDown: true` only when the call actually flipped a
 * `starting`/`live` row.
 */
export function previewTeardownHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const actor = body !== null ? optionalString(body, "actor") : undefined;

		if (deps.db === undefined) {
			return jsonResponse(503, {
				error: {
					code: "preview_teardown_unavailable",
					message: "preview teardown requires the repo layer; this warren has no db handle wired",
				},
			});
		}

		const previews = createRunPreviewsRepo(deps.db);
		const result = await teardownPreview({
			runId,
			repos: deps.repos,
			previews,
			burrowClientPool: deps.burrowClientPool,
			broker: deps.broker,
			...(actor !== undefined ? { actor } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			logger: teardownLoggerFor(deps),
		});

		return jsonResponse(200, {
			status: result.status,
			tornDown: result.tornDown,
			previousState: result.previousState,
			port: result.port,
		});
	};
}

/**
 * Narrow `ServerDeps.logger` (the pino-shaped surface) onto the
 * `Record<string, unknown>` signature the preview teardown / eviction
 * code expects. Same shape the boot path already builds for the
 * eviction worker — kept inline here to avoid threading another
 * `*LoggerFromPino` adapter down through `ServerDeps`.
 */
function teardownLoggerFor(deps: ServerDeps): {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
} {
	return {
		info: (obj, msg) => deps.logger.info(obj, msg),
		warn: (obj, msg) => deps.logger.warn(obj, msg),
		error: (obj, msg) => deps.logger.error(obj, msg),
	};
}

export function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		const run = await deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		// warren-a8c3: tag every NDJSON envelope with the run's plot_id so
		// Plot-aware consumers can route mirrored events (warren-7e0f) without
		// a second GET /runs/:id call. Snapshot at stream-open time — plot_id
		// is set at spawn and never mutates, so the closure-captured value is
		// authoritative for the life of the stream.
		const plotId = run.plotId;
		return ndjsonResponse(asNdjsonStream(source, (row) => eventToNdjson(row, plotId), ctrl));
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming plumbing                                                       */
/* ----------------------------------------------------------------------- */

export function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

export function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

export function eventToNdjson(
	row: {
		id: number;
		runId: string;
		burrowEventSeq: number;
		ts: string;
		kind: string;
		stream: string | null;
		payloadJson: unknown;
	},
	plotId: string | null = null,
): string {
	return `${JSON.stringify({
		id: row.id,
		runId: row.runId,
		seq: row.burrowEventSeq,
		ts: row.ts,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
		plotId,
	})}\n`;
}
