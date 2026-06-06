/**
 * Handlers for warren's HTTP API (SPEC §8.1) — route-table composer
 * and shared parsing helpers.
 *
 * Domain handlers live alongside in `./agents.ts`, `./projects.ts`,
 * `./burrows.ts`, `./workers.ts`, `./runs.ts`, `./plan-runs.ts`,
 * `./plots.ts`, `./plot-plan-runs.ts`, `./diagnostics.ts`, and
 * `./meta.ts`. Each is a thin envelope around a function in `runs/`,
 * `registry/`, `projects/`, or `db/repos/` — the modules already do
 * validation, state machines, and burrow shell-out, so handlers only
 * shape the wire IO.
 *
 * Streaming surface (`GET /runs/:id/events?follow=1`) bridges
 * `tailRunEvents` onto NDJSON. Cleanup follows the same pattern burrow
 * uses (mx-b3423b): `request.signal` propagates to a per-stream
 * AbortController; the source generator returns cleanly on abort;
 * `ReadableStream.cancel` aborts back into the generator if the consumer
 * cancels first. The events generator already tears down its broker
 * subscription in a `finally`, so no broker entries leak.
 *
 * Spawn (`POST /runs`) registers a fresh bridge against the run via
 * `deps.bridges.start()` so the live tail has events to read. Without
 * this hook the run dispatches into burrow but warren never persists
 * any of its events — a regression Phase 6 would otherwise re-introduce.
 *
 * `POST /agents/refresh` is sync from the wire's POV (the canopy clone +
 * per-prompt render runs to completion before responding). We don't
 * stream progress events; if a refresh starts taking minutes the right
 * answer is to add a Phase 13-style readyz/doctor signal, not to bolt a
 * progress channel onto this route.
 */

import { ValidationError } from "../../core/errors.ts";
import { isValidPlotIdFormat, PlotIdInvalidError, PlotIdNotFoundError } from "../../plots/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import type { Route, RouteContext, RouteHandler, ServerDeps } from "../types.ts";
import {
	getAgentHandler,
	listAgentsHandler,
	refreshAgentsHandler,
	refreshProjectAgentsHandler,
} from "./agents.ts";
import { getBurrowHandler, listBurrowsHandler } from "./burrows.ts";
import {
	createConversationHandler,
	getConversationHandler,
	listConversationsHandler,
	postConversationMessageHandler,
	rewakeConversationHandler,
	sendOffConversationHandler,
} from "./conversations.ts";
import { readyzHandler } from "./diagnostics.ts";
import { healthzHandler, previewConfigHandler, versionHandler } from "./meta.ts";
import {
	cancelPlanRunHandler,
	createPlanRunHandler,
	getPlanRunHandler,
	listPlanRunsHandler,
	streamPlanRunEventsHandler,
} from "./plan-runs.ts";
import { createPlotPlanRunHandler } from "./plot-plan-runs.ts";
import {
	answerPlotQuestionHandler,
	attachPlotHandler,
	changePlotStatusHandler,
	createPlotHandler,
	detachPlotHandler,
	editPlotIntentHandler,
	formalizePlotHandler,
	getPlotHandler,
	getPlotSummaryHandler,
	listPlotsHandler,
	mergePlotPrAttachmentHandler,
	needsAttentionCountHandler,
	renamePlotHandler,
	syncPlotHandler,
} from "./plots/index.ts";
import {
	createProjectHandler,
	deleteProjectHandler,
	getProjectSeedHandler,
	getProjectTriggersHandler,
	getProjectWarrenConfigHandler,
	listProjectsHandler,
	refreshProjectHandler,
	runProjectTriggerHandler,
} from "./projects.ts";
import {
	cancelRunHandler,
	createRunHandler,
	getRunHandler,
	listBehaviorAnalyticsHandler,
	listCostAnalyticsHandler,
	listRunAnalyticsHandler,
	listRunsHandler,
	previewLoginHandler,
	previewTeardownHandler,
	steerRunHandler,
	streamRunEventsHandler,
} from "./runs/index.ts";
import { drainWorkerHandler, listWorkersHandler } from "./workers.ts";

/**
 * Run a command via `Bun.spawn` and return the SpawnResult shape the
 * registry/projects modules expect. Non-zero exit codes are surfaced to
 * the caller; transport-level failures (binary missing, timeout) bubble
 * as the underlying Error so the call-site error mapper can wrap them.
 */
export const defaultSpawn: SpawnFn = async (
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer =
		opts.timeoutMs !== undefined && opts.timeoutMs > 0
			? setTimeout(() => proc.kill(), opts.timeoutMs)
			: null;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== null) clearTimeout(timer);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
};

/* ----------------------------------------------------------------------- */
/* Body / param parsing                                                     */
/* ----------------------------------------------------------------------- */

export async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
	const parsed = await readJsonBodyOrEmpty(ctx);
	if (parsed === null) {
		throw new ValidationError("request body is empty; expected a JSON object");
	}
	return parsed;
}

export async function readJsonBodyOrEmpty(
	ctx: RouteContext,
): Promise<Record<string, unknown> | null> {
	const raw = await ctx.request.text();
	if (raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' is required and must be a non-empty string`);
	}
	return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string`);
	}
	return value;
}

export function requireParam(ctx: RouteContext, key: string): string {
	const value = ctx.params[key];
	if (value === undefined || value.length === 0) {
		throw new ValidationError(`route param '${key}' is missing`);
	}
	return value;
}

export function parseBoolean(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	throw new ValidationError(`${label} must be 'true'/'1' or 'false'/'0'; got '${raw}'`);
}

export function parseNonNegativeInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a non-negative integer; got '${raw}'`);
	}
	return n;
}

/**
 * Validate `plotId` at the dispatch edge (POST /runs, POST /plan-runs).
 * Both inputs are normalized so an undefined / empty string passes
 * through unchanged — "no plot bound" is a first-class shape.
 *
 * Format check is always-on (`isValidPlotIdFormat`). Existence check
 * runs only when `plotResolver` is wired on ServerDeps (production
 * wires it in src/server/main/index.ts). Test harnesses that omit the
 * resolver get format-only validation, which matches the existing
 * per-Plot handler posture in this file (`deps.plotResolver !==
 * undefined ? ... : null`).
 *
 * warren-bae5 / pl-5310 step 2 — fold-in of warren-a353.
 */
export async function assertPlotIdDispatchable(input: {
	readonly plotId: string | undefined;
	readonly plotResolver?: import("../../plots/index.ts").PlotResolver;
}): Promise<void> {
	const { plotId, plotResolver } = input;
	if (plotId === undefined || plotId === "") return;
	if (!isValidPlotIdFormat(plotId)) {
		throw new PlotIdInvalidError(
			`plot_id ${JSON.stringify(plotId)} is not a valid Plot ID (expected shape: plot-<lower-alphanum>+)`,
			{
				recoveryHint:
					"Plot IDs look like `plot-3e72876d`. Visit /plots to copy the canonical id of an existing Plot.",
			},
		);
	}
	if (plotResolver === undefined) return;
	const owning = await plotResolver.resolve(plotId);
	if (owning === null) {
		throw new PlotIdNotFoundError(`plot_id ${plotId} does not match any known Plot`, {
			recoveryHint: "Verify the Plot exists at /plots, or omit plot_id to dispatch an unbound run.",
		});
	}
}

/* ----------------------------------------------------------------------- */
/* Route table                                                              */
/* ----------------------------------------------------------------------- */

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
	readonly build: (deps: ServerDeps) => RouteHandler;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", build: () => healthzHandler() },
	{ method: "GET", pattern: "/readyz", build: readyzHandler },
	{ method: "GET", pattern: "/version", build: () => versionHandler() },

	{ method: "GET", pattern: "/agents", build: listAgentsHandler },
	{ method: "POST", pattern: "/agents/refresh", build: refreshAgentsHandler },
	{ method: "GET", pattern: "/agents/:name", build: getAgentHandler },

	{ method: "GET", pattern: "/projects", build: listProjectsHandler },
	{ method: "POST", pattern: "/projects", build: createProjectHandler },
	{ method: "GET", pattern: "/projects/:id/warren-config", build: getProjectWarrenConfigHandler },
	{ method: "GET", pattern: "/projects/:id/triggers", build: getProjectTriggersHandler },
	{ method: "GET", pattern: "/projects/:id/seeds/:seedId", build: getProjectSeedHandler },
	{
		method: "POST",
		pattern: "/projects/:id/triggers/:triggerId/run",
		build: runProjectTriggerHandler,
	},
	{ method: "POST", pattern: "/projects/:id/refresh", build: refreshProjectHandler },
	{
		method: "POST",
		pattern: "/projects/:id/agents/refresh",
		build: refreshProjectAgentsHandler,
	},
	{ method: "DELETE", pattern: "/projects/:id", build: deleteProjectHandler },

	{ method: "GET", pattern: "/burrows", build: listBurrowsHandler },
	{ method: "GET", pattern: "/burrows/:id", build: getBurrowHandler },

	{ method: "GET", pattern: "/workers", build: listWorkersHandler },
	{ method: "POST", pattern: "/workers/:name/drain", build: drainWorkerHandler },

	{ method: "GET", pattern: "/analytics/cost", build: listCostAnalyticsHandler },
	{ method: "GET", pattern: "/analytics/runs", build: listRunAnalyticsHandler },
	{ method: "GET", pattern: "/analytics/behavior", build: listBehaviorAnalyticsHandler },
	{ method: "GET", pattern: "/runs", build: listRunsHandler },
	{ method: "POST", pattern: "/runs", build: createRunHandler },
	{ method: "GET", pattern: "/runs/:id", build: getRunHandler },
	{ method: "GET", pattern: "/runs/:id/events", build: streamRunEventsHandler },
	{ method: "POST", pattern: "/runs/:id/steer", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", build: cancelRunHandler },
	{ method: "GET", pattern: "/runs/:id/preview/login", build: previewLoginHandler },
	{ method: "POST", pattern: "/runs/:id/preview/teardown", build: previewTeardownHandler },

	{ method: "GET", pattern: "/preview/config", build: previewConfigHandler },

	{ method: "GET", pattern: "/plan-runs", build: listPlanRunsHandler },
	{ method: "POST", pattern: "/plan-runs", build: createPlanRunHandler },
	{ method: "POST", pattern: "/plot-plan-runs", build: createPlotPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id", build: getPlanRunHandler },
	{ method: "POST", pattern: "/plan-runs/:id/cancel", build: cancelPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id/events", build: streamPlanRunEventsHandler },

	{ method: "GET", pattern: "/conversations", build: listConversationsHandler },
	{ method: "POST", pattern: "/conversations", build: createConversationHandler },
	{ method: "GET", pattern: "/conversations/:id", build: getConversationHandler },
	{
		method: "POST",
		pattern: "/conversations/:id/messages",
		build: postConversationMessageHandler,
	},
	{
		method: "POST",
		pattern: "/conversations/:id/send-off",
		build: sendOffConversationHandler,
	},
	{
		method: "POST",
		pattern: "/conversations/:id/re-wake",
		build: rewakeConversationHandler,
	},

	{ method: "GET", pattern: "/plots", build: listPlotsHandler },
	{ method: "POST", pattern: "/plots", build: createPlotHandler },
	// Static path — must precede `/plots/:id` so the param route doesn't
	// swallow `needs-attention` as an :id.
	{
		method: "GET",
		pattern: "/plots/needs-attention/count",
		build: needsAttentionCountHandler,
	},
	{ method: "POST", pattern: "/plots/:id/formalize", build: formalizePlotHandler },
	// Static-suffix path — must precede `/plots/:id` so the param route
	// doesn't swallow `summary` as the rest of the id.
	{ method: "GET", pattern: "/plots/:id/summary", build: getPlotSummaryHandler },
	{ method: "GET", pattern: "/plots/:id", build: getPlotHandler },
	{ method: "POST", pattern: "/plots/:id/intent", build: editPlotIntentHandler },
	{ method: "POST", pattern: "/plots/:id/rename", build: renamePlotHandler },
	{ method: "POST", pattern: "/plots/:id/sync", build: syncPlotHandler },
	{ method: "POST", pattern: "/plots/:id/status", build: changePlotStatusHandler },
	{ method: "POST", pattern: "/plots/:id/attachments", build: attachPlotHandler },
	// Specific path — must precede `/plots/:id/attachments/:ref` so the
	// DELETE-by-ref route doesn't swallow `<ref>/merge` as a ref.
	{
		method: "POST",
		pattern: "/plots/:id/attachments/:ref/merge",
		build: mergePlotPrAttachmentHandler,
	},
	{
		method: "DELETE",
		pattern: "/plots/:id/attachments/:ref",
		build: detachPlotHandler,
	},
	{
		method: "POST",
		pattern: "/plots/:id/questions/:event_id/answer",
		build: answerPlotQuestionHandler,
	},
];

/**
 * Matches `/runs/<id>/preview/login` (the auth-exempt signed-cookie
 * handshake from SPEC §11.L). Kept module-scoped so the request gate
 * doesn't compile a regex per request.
 */
const PREVIEW_LOGIN_PATH_RE = /^\/runs\/[^/]+\/preview\/login\/?$/;

export function buildApiRoutes(deps: ServerDeps): Route[] {
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		handler: entry.build(deps),
	}));
}

/**
 * Top-level prefixes the API claims. Any pathname under one of these is
 * an API request: it requires auth (except `/healthz`, see
 * `isAuthExempt`) and the SPA fallback in `ui.ts` refuses to serve
 * `index.html` for it. Kept in sync with `ROUTE_TABLE` by hand — the
 * router patterns are richer than prefixes (`/agents/:name`,
 * `/runs/:id/events`) so we can't derive these without either parsing
 * the patterns or duplicating the policy.
 */
export const API_PREFIXES: readonly string[] = [
	"/agents",
	"/analytics",
	"/burrows",
	"/conversations",
	"/projects",
	"/runs",
	"/workers",
	"/healthz",
	"/readyz",
	"/version",
	"/preview",
	"/plan-runs",
	"/plot-plan-runs",
	"/plots",
];

/**
 * True iff `pathname` is one of the API surfaces above. Cheap prefix
 * scan — five entries, no allocations on the hot path.
 */
export function isApiPath(pathname: string): boolean {
	for (const prefix of API_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * Auth predicate for the request gate (server.ts).
 *
 * Exempt:
 *   - `/healthz` — liveness probes can't carry a token and the response
 *     is non-sensitive (`{ok: true}`).
 *   - Every non-API path — the SPA shell (`/`), its static assets
 *     (`/assets/<hash>`), and React Router deep links must be reachable
 *     from a fresh browser. Otherwise the user can't load `Login.tsx`
 *     to enter their bearer token (chicken-and-egg, warren-d2a5).
 *
 * Auth-required:
 *   - Every API path other than `/healthz`. `/readyz` stays gated
 *     because its body reveals which checks failed (sensitive in a
 *     misconfigured deploy).
 */
export function isAuthExempt(pathname: string): boolean {
	if (pathname === "/healthz") return true;
	// `/version` is non-sensitive (just the package version string) and
	// the UI fetches it before the user logs in to render in the sidebar
	// header. Keeping it auth-exempt avoids a chicken-and-egg on the
	// login screen.
	if (pathname === "/version") return true;
	// Preview login handshake (R-19 / SPEC §11.L): the browser arrives
	// without an Authorization header and validates the bearer via
	// `?token=<WARREN_API_TOKEN>`. The handler does its own constant-time
	// compare, so the global gate must let the request through.
	if (PREVIEW_LOGIN_PATH_RE.test(pathname)) return true;
	return !isApiPath(pathname);
}

export const API_ROUTE_PATTERNS: readonly { method: Route["method"]; pattern: string }[] =
	ROUTE_TABLE.map((e) => ({ method: e.method, pattern: e.pattern }));
