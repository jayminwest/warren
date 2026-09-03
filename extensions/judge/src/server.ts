/**
 * The export surface (plan pl-17ca step 8, warren-265d).
 *
 * `GET /verdicts.jsonl?since=<id>&limit=<n>` pages the append-only verdict
 * store oldest-first: rows with `id > since`, capped at `limit`. Because ids
 * are SQLite rowids under a single writer and a replayed judgment never
 * consumes one (verdict-store.ts), `since = last id seen` pages with no
 * skips and no duplicates across page boundaries. The response carries
 * `X-Verdicts-Max-Id`, the highest id assigned at read time, so a client
 * can checkpoint even when the page is empty. Verdict rows and unjudged
 * markers export side by side — a budget skip is a first-class, visible
 * row (§12.5), never a silent gap.
 *
 * `GET /agreement` exposes the stored calibration metric (§12.5): the
 * cheap↔strong band-agreement report the calibration pass persists per
 * rubric version. Without parameters it returns the latest report for
 * every rubric version that has one; `?rubricVersion=<v>` returns that
 * version's latest report plus history (`?limit=<n>`, newest first).
 * Trend lines must never mix rubric versions, so the rubric version is
 * part of every report's identity.
 *
 * Auth: bearer-gated from birth — every route except a minimal `/healthz`
 * requires `Authorization: Bearer <JUDGE_EXPORT_TOKEN>`. There is no
 * public projection: a missing or wrong token is a flat 401, never a
 * degraded read-only view. Warren has no extension-auth contract to
 * delegate to (FRICTION §4), so the token is a static operator-minted
 * credential the extension holds in closure and never logs.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { AgreementReport, CalibrationMetricStore } from "./calibration.ts";
import type { StoreRow, VerdictStore } from "./verdict-store.ts";

export interface ExportServerDeps {
	readonly verdicts: VerdictStore;
	/** Null when calibration is disabled — /agreement then reports empty. */
	readonly metrics: CalibrationMetricStore | null;
	/** The static bearer credential (JUDGE_EXPORT_TOKEN). */
	readonly exportToken: string;
	readonly extensionName: string;
	readonly extensionVersion: string;
	/** 0 picks an ephemeral port (tests). */
	readonly port: number;
}

export type ExportServer = ReturnType<typeof Bun.serve>;

const DEFAULT_PAGE_LIMIT = 1000;
const MAX_PAGE_LIMIT = 10000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

function badRequest(message: string): Response {
	return Response.json({ error: message }, { status: 400 });
}

function unauthorized(): Response {
	return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Constant-time bearer check. Both sides are hashed first so the compare
 * never leaks length, and a missing/malformed header short-circuits to the
 * same 401 — no oracle between "no token" and "wrong token".
 */
function isAuthorized(req: Request, exportToken: string): boolean {
	const header = req.headers.get("authorization");
	if (header === null || !header.startsWith("Bearer ")) return false;
	const presented = createHash("sha256").update(header.slice("Bearer ".length)).digest();
	const expected = createHash("sha256").update(exportToken).digest();
	return timingSafeEqual(presented, expected);
}

function parseNonNegativeInt(raw: string): number | null {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw) return null;
	return parsed;
}

function parsePageLimit(url: URL): number | Response {
	const rawLimit = url.searchParams.get("limit");
	if (rawLimit === null) return DEFAULT_PAGE_LIMIT;
	const parsed = Number.parseInt(rawLimit, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== rawLimit) {
		return badRequest(`limit must be a positive integer; got '${rawLimit}'`);
	}
	return Math.min(parsed, MAX_PAGE_LIMIT);
}

function serveVerdicts(verdicts: VerdictStore, url: URL): Response {
	const rawSince = url.searchParams.get("since") ?? "0";
	const since = parseNonNegativeInt(rawSince);
	if (since === null) {
		return badRequest(`since must be a non-negative integer; got '${rawSince}'`);
	}
	const limit = parsePageLimit(url);
	if (limit instanceof Response) return limit;
	// `order=desc` serves the newest page (warren-f282): the rows with the
	// highest ids, descending. Default stays ascending for cursor paging.
	const rawOrder = url.searchParams.get("order") ?? "asc";
	if (rawOrder !== "asc" && rawOrder !== "desc") {
		return badRequest(`order must be 'asc' or 'desc'; got '${rawOrder}'`);
	}
	const rows: readonly StoreRow[] = verdicts.rowsSince(since, limit, rawOrder);
	const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
	return new Response(body, {
		headers: {
			"content-type": "application/x-ndjson",
			"X-Verdicts-Max-Id": String(verdicts.maxId()),
		},
	});
}

function serveAgreement(metrics: CalibrationMetricStore | null, url: URL): Response {
	if (metrics === null) {
		// Calibration disabled: the honest answer is an empty report list,
		// not a 404 — the surface is up, the metric source is off.
		return Response.json({ reports: [] });
	}
	const rubricVersion = url.searchParams.get("rubricVersion");
	if (rubricVersion === null) {
		const reports = metrics
			.rubricVersions()
			.map((v) => metrics.latestForRubric(v))
			.filter((r): r is AgreementReport => r !== null);
		return Response.json({ reports });
	}
	const rawLimit = url.searchParams.get("limit");
	let limit = DEFAULT_HISTORY_LIMIT;
	if (rawLimit !== null) {
		const parsed = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== rawLimit) {
			return badRequest(`limit must be a positive integer; got '${rawLimit}'`);
		}
		limit = Math.min(parsed, MAX_HISTORY_LIMIT);
	}
	const latest = metrics.latestForRubric(rubricVersion);
	if (latest === null) {
		return Response.json(
			{ error: `no calibration reports for rubric version '${rubricVersion}'` },
			{ status: 404 },
		);
	}
	return Response.json({ latest, history: metrics.historyForRubric(rubricVersion, limit) });
}

/** Minimal liveness — the one unauthenticated route, and it reports no data. */
function serveHealth(deps: Omit<ExportServerDeps, "port">, startedAt: Date): Response {
	return Response.json({
		status: "ok",
		extension: deps.extensionName,
		version: deps.extensionVersion,
		uptimeMs: Date.now() - startedAt.getTime(),
	});
}

/** Build the fetch handler; exported separately so tests can skip sockets. */
export function createFetchHandler(
	deps: Omit<ExportServerDeps, "port">,
): (req: Request) => Response {
	const startedAt = new Date();
	return (req) => {
		const url = new URL(req.url);
		if (req.method !== "GET") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		if (url.pathname === "/healthz") return serveHealth(deps, startedAt);
		if (!isAuthorized(req, deps.exportToken)) return unauthorized();
		if (url.pathname === "/verdicts.jsonl") return serveVerdicts(deps.verdicts, url);
		if (url.pathname === "/agreement") return serveAgreement(deps.metrics, url);
		return Response.json({ error: "not found" }, { status: 404 });
	};
}

/** Serve the export surface until `stop()` is called. */
export function createExportServer(deps: ExportServerDeps): ExportServer {
	return Bun.serve({ port: deps.port, fetch: createFetchHandler(deps) });
}
