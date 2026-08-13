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
import type { RouteContext } from "../types.ts";

export {
	API_PREFIXES,
	API_ROUTE_PATTERNS,
	API_ROUTE_POLICIES,
	buildApiRoutes,
	isApiPath,
	isAuthExempt,
} from "./route-table.ts";
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

export function parsePositiveInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a positive integer; got '${raw}'`);
	}
	return n;
}
