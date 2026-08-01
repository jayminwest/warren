/**
 * Handlers for warren's HTTP API (docs/http-api.md) — route-table composer
 * and shared parsing helpers.
 *
 * Domain handlers live alongside in `./agents.ts`, `./projects.ts`,
 * `./burrows.ts`, `./workers.ts`, `./runs.ts`, `./plan-runs.ts`,
 * `./diagnostics.ts`, and `./meta.ts`. Each is a thin envelope around a
 * function in `runs/`, `registry/`, `projects/`, or `db/repos/` — the
 * modules already do validation, state machines, and burrow shell-out,
 * so handlers only shape the wire IO.
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
 * `POST /projects/:id/agents/refresh` is sync from the wire's POV (the
 * per-prompt render runs to completion before responding). We don't
 * stream progress events; if a refresh starts taking minutes the right
 * answer is to add a Phase 13-style readyz/doctor signal, not to bolt a
 * progress channel onto this route.
 */

import { ValidationError } from "../../core/errors.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import type { Route, RouteContext, RouteHandler, RoutePolicy, ServerDeps } from "../types.ts";
import { getAgentHandler, listAgentsHandler } from "./agents.ts";
import { healAlertHandler } from "./alerts.ts";
import { readyzHandler } from "./diagnostics.ts";
import { healthzHandler, previewConfigHandler, versionHandler, whoamiHandler } from "./meta.ts";
import { metricsHandler } from "./metrics.ts";
import {
	cancelPlanRunHandler,
	createPlanRunHandler,
	getPlanRunHandler,
	listPlanRunsHandler,
	streamPlanRunEventsHandler,
} from "./plan-runs.ts";
import {
	createProjectHandler,
	deleteProjectHandler,
	getProjectSeedHandler,
	getProjectTriggersHandler,
	getProjectWarrenConfigHandler,
	listProjectSeedPlansHandler,
	listProjectsHandler,
	listReadyPlansHandler,
	refreshProjectHandler,
	runProjectTriggerHandler,
} from "./projects.ts";
import {
	cancelRunHandler,
	createRunHandler,
	getRunFinalizeIntentHandler,
	getRunHandler,
	listBehaviorAnalyticsHandler,
	listCostAnalyticsHandler,
	listRunAnalyticsHandler,
	listRunsHandler,
	pollRunInboxHandler,
	postRunFinalizeResultHandler,
	postRunSalvageHandler,
	previewLoginHandler,
	previewTeardownHandler,
	steerRunHandler,
	streamRunEventsHandler,
} from "./runs/index.ts";

/**
 * The production `Bun.spawn` adaptor, re-exported so the domain handlers
 * keep importing their shared helpers from this one module.
 */
export { defaultSpawn };

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

/* ----------------------------------------------------------------------- */
/* Route table                                                              */
/* ----------------------------------------------------------------------- */

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
	/**
	 * The capability this route demands (warren-b875). Required — TypeScript
	 * refuses an entry that omits it, so a new route can never default to
	 * open. Enforced once, in `handleRequest` (`src/server/server.ts`).
	 */
	readonly policy: RoutePolicy;
	readonly build: (deps: ServerDeps) => RouteHandler;
}

/**
 * Every route and the capability it requires (warren-b875).
 *
 * The classification, in one place so the whole surface can be read at once:
 *
 * - `anonymous` — no auth gate at all. `/healthz` (liveness probes carry no
 *   token) and `/version` (the login screen reads it before the user has
 *   one). `isAuthExempt` is DERIVED from these two entries, so the exemption
 *   list can't drift from the policy table.
 * - `readPublic` — the demo surface a `WARREN_AUTH=public` spectator sees: the
 *   run / project / agent / plan-run listings and details, the run event stream,
 *   `/whoami` (the caller's own identity), and `/analytics/runs`. Each is served
 *   through a public projection (pl-b82d steps 14-16) before an instance is
 *   actually exposed; the policy is what makes the projection reachable, not
 *   what makes it safe.
 * - `readOperator` — reads that are NOT for spectators. `/readyz` and
 *   `/metrics` are operator diagnostics (the latter deliberately not
 *   auth-exempt, warren-682a). `/analytics/cost` is the instance-wide USD
 *   rollup (per-run cost on a run detail is a deliberate exception).
 *   `/analytics/behavior` and the per-project seeds / ready-plans reads
 *   surface project internals. `/projects/:id/triggers` and
 *   `/projects/:id/warren-config` carry trigger prompt text, `qualityGate`
 *   command strings, and admission caps. `/preview/config` discloses
 *   `WARREN_PREVIEW_HOST`. `GET /runs/:id/inbox` is here for a stronger
 *   reason than disclosure: it MUTATES on read (`src/runs/inbox.ts` claims
 *   unread rows and flips them to delivered), so an anonymous poll would
 *   silently drain the operator's steering queue.
 * - `dispatch` — starts or steers agent work: the run and plan-run
 *   lifecycle, the trigger fire, the pod's finalize callback, and the
 *   `/alerts/heal` intake (a webhook that dispatches a healer run).
 * - `admin` — instance-level mutation: registering / deleting / refreshing
 *   projects and the agent registry.
 *
 * Default-deny is the rule: a route absent from the public list above is
 * `readOperator` or narrower, and there is nowhere to declare "open".
 */
const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", policy: "anonymous", build: () => healthzHandler() },
	{ method: "GET", pattern: "/readyz", policy: "readOperator", build: readyzHandler },
	{ method: "GET", pattern: "/version", policy: "anonymous", build: () => versionHandler() },
	{ method: "GET", pattern: "/metrics", policy: "readOperator", build: metricsHandler },
	// warren-e195: `readPublic`, not `anonymous` — an exempt route gets no actor to name.
	{ method: "GET", pattern: "/whoami", policy: "readPublic", build: () => whoamiHandler() },

	{ method: "GET", pattern: "/agents", policy: "readPublic", build: listAgentsHandler },
	{ method: "GET", pattern: "/agents/:name", policy: "readPublic", build: getAgentHandler },

	// warren-3db0: closed-loop alert intake. Token-gated via the standard
	// bearer gate (not auth-exempt); webhook senders carry the bearer.
	{ method: "POST", pattern: "/alerts/heal", policy: "dispatch", build: healAlertHandler },

	{ method: "GET", pattern: "/projects", policy: "readPublic", build: listProjectsHandler },
	{ method: "POST", pattern: "/projects", policy: "admin", build: createProjectHandler },
	{
		method: "GET",
		pattern: "/projects/:id/warren-config",
		policy: "readOperator",
		build: getProjectWarrenConfigHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/triggers",
		policy: "readOperator",
		build: getProjectTriggersHandler,
	},
	// Static path — must precede `/projects/:id/seeds/:seedId` so the param
	// route doesn't swallow `plans` as a seed id.
	{
		method: "GET",
		pattern: "/projects/:id/seeds/plans",
		policy: "readOperator",
		build: listProjectSeedPlansHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/ready-plans",
		policy: "readOperator",
		build: listReadyPlansHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/seeds/:seedId",
		policy: "readOperator",
		build: getProjectSeedHandler,
	},
	{
		method: "POST",
		pattern: "/projects/:id/triggers/:triggerId/run",
		policy: "dispatch",
		build: runProjectTriggerHandler,
	},
	{
		method: "POST",
		pattern: "/projects/:id/refresh",
		policy: "admin",
		build: refreshProjectHandler,
	},
	{ method: "DELETE", pattern: "/projects/:id", policy: "admin", build: deleteProjectHandler },

	{
		method: "GET",
		pattern: "/analytics/cost",
		policy: "readOperator",
		build: listCostAnalyticsHandler,
	},
	{
		method: "GET",
		pattern: "/analytics/runs",
		policy: "readPublic",
		build: listRunAnalyticsHandler,
	},
	{
		method: "GET",
		pattern: "/analytics/behavior",
		policy: "readOperator",
		build: listBehaviorAnalyticsHandler,
	},
	{ method: "GET", pattern: "/runs", policy: "readPublic", build: listRunsHandler },
	{ method: "POST", pattern: "/runs", policy: "dispatch", build: createRunHandler },
	{ method: "GET", pattern: "/runs/:id", policy: "readPublic", build: getRunHandler },
	{
		method: "GET",
		pattern: "/runs/:id/events",
		policy: "readPublic",
		build: streamRunEventsHandler,
	},
	// warren-3d0b: the in-pod steering poll for the K8s backend. Bearer-gated
	// like every /runs route; the pod carries its per-run SCOPED token
	// (warren-57fd). Destructive on read (it claims unread messages), so for a
	// non-run caller it is operator-only (warren-b875).
	{ method: "GET", pattern: "/runs/:id/inbox", policy: "readOperator", build: pollRunInboxHandler },
	// warren-0d35: the in-pod finalize callback for the K8s backend — the pod
	// fetches the reap intent, runs the workspace-dependent half in place, and
	// POSTs the FinalizeResult back. Bearer-gated; the pod carries its per-run
	// scoped token (warren-57fd).
	{
		method: "GET",
		pattern: "/runs/:id/finalize-intent",
		policy: "readOperator",
		build: getRunFinalizeIntentHandler,
	},
	{
		method: "POST",
		pattern: "/runs/:id/finalize-result",
		policy: "dispatch",
		build: postRunFinalizeResultHandler,
	},
	// warren-cd3b: the in-pod salvage intake — the pod POSTs the work it
	// captured (rescue ref + git bundle) when the finalize branch push failed
	// or no reap intent ever arrived, BEFORE its emptyDir dies with the pod.
	{
		method: "POST",
		pattern: "/runs/:id/salvage",
		policy: "dispatch",
		build: postRunSalvageHandler,
	},
	{ method: "POST", pattern: "/runs/:id/steer", policy: "dispatch", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", policy: "dispatch", build: cancelRunHandler },
	// warren-e1b0: POST, not GET — the bearer rides the `Authorization`
	// header like every other /runs route instead of a `?token=` query
	// string that would land in history / Referer / proxy logs.
	{
		method: "POST",
		pattern: "/runs/:id/preview/login",
		policy: "dispatch",
		build: previewLoginHandler,
	},
	{
		method: "POST",
		pattern: "/runs/:id/preview/teardown",
		policy: "dispatch",
		build: previewTeardownHandler,
	},

	{
		method: "GET",
		pattern: "/preview/config",
		policy: "readOperator",
		build: previewConfigHandler,
	},

	{ method: "GET", pattern: "/plan-runs", policy: "readPublic", build: listPlanRunsHandler },
	{ method: "POST", pattern: "/plan-runs", policy: "dispatch", build: createPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id", policy: "readPublic", build: getPlanRunHandler },
	{
		method: "POST",
		pattern: "/plan-runs/:id/cancel",
		policy: "dispatch",
		build: cancelPlanRunHandler,
	},
	{
		method: "GET",
		pattern: "/plan-runs/:id/events",
		policy: "readPublic",
		build: streamPlanRunEventsHandler,
	},
];

export function buildApiRoutes(deps: ServerDeps): Route[] {
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		policy: entry.policy,
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
	"/alerts",
	"/analytics",
	"/projects",
	"/runs",
	"/healthz",
	"/readyz",
	"/version",
	"/metrics",
	"/preview",
	"/plan-runs",
	"/whoami",
];

/**
 * True iff `pathname` is one of the API surfaces above. Cheap prefix
 * scan — a handful of entries, no allocations on the hot path.
 */
export function isApiPath(pathname: string): boolean {
	for (const prefix of API_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * API paths the auth gate skips entirely — derived from the routes whose
 * declared policy is `anonymous` (warren-b875), so the exemption list is the
 * policy table rather than a second hand-maintained copy of it. Only static
 * patterns can appear here; a `:param` pattern would never match a real
 * pathname by string equality (asserted in `index.test.ts`).
 */
const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(
	ROUTE_TABLE.filter((e) => e.policy === "anonymous").map((e) => e.pattern),
);

/**
 * Auth predicate for the request gate (server.ts).
 *
 * Exempt:
 *   - Every `anonymous`-policy route: `/healthz` (liveness probes can't
 *     carry a token and the response is non-sensitive, `{ok: true}`) and
 *     `/version` (just the package version string, which the UI fetches
 *     before the user logs in — keeping it exempt avoids a chicken-and-egg
 *     on the login screen).
 *   - Every non-API path — the SPA shell (`/`), its static assets
 *     (`/assets/<hash>`), and React Router deep links must be reachable
 *     from a fresh browser. Otherwise the user can't load `Login.tsx`
 *     to enter their bearer token (chicken-and-egg, warren-d2a5).
 *
 * Auth-required:
 *   - Every other API path, and beyond the gate its declared `RoutePolicy`
 *     decides whether the admitted actor may proceed. `/metrics` is
 *     deliberately NOT exempt (warren-682a): behind a public Ingress the
 *     scrape surface leaks operational shape (run counts, pod phases, queue
 *     depth). In-cluster Prometheus scrapes it with the bearer via the
 *     ServiceMonitor's `authorization` credentials
 *     (deploy/k8s/servicemonitor.yaml). `/readyz` stays gated because its
 *     body reveals which checks failed (sensitive in a misconfigured
 *     deploy). `POST /runs/:id/preview/login` is gated too (warren-e1b0) —
 *     it used to be exempt so a browser could hand the bearer over in a
 *     `?token=` query string; the handshake now carries the bearer in the
 *     `Authorization` header like every other `/runs/*` route, so the
 *     exemption is gone.
 */
export function isAuthExempt(pathname: string): boolean {
	if (AUTH_EXEMPT_PATHS.has(pathname)) return true;
	return !isApiPath(pathname);
}

/**
 * The declared policy of every API route (warren-b875) — the readable form
 * of `ROUTE_TABLE` for tests and tooling that must not build handlers.
 */
export const API_ROUTE_POLICIES: readonly {
	method: Route["method"];
	pattern: string;
	policy: RoutePolicy;
}[] = ROUTE_TABLE.map((e) => ({ method: e.method, pattern: e.pattern, policy: e.policy }));

export const API_ROUTE_PATTERNS: readonly { method: Route["method"]; pattern: string }[] =
	API_ROUTE_POLICIES;
