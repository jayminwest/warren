/**
 * The export and health surface (plan step 4, warren-9c7c).
 *
 * `GET /audit-log.jsonl?since=<id>&limit=<n>` pages the append-only audit
 * log oldest-first: rows with `id > since`, capped at `limit`. Because ids
 * are assigned by SQLite's rowid under a single writer and a replayed fact
 * never consumes one (audit-store.ts), `since = last id seen` pages with no
 * skips and no duplicates across page boundaries. The response carries
 * `X-Audit-Log-Max-Id`, the highest id assigned at read time, so a client
 * can checkpoint even when the page is empty.
 *
 * `GET /healthz` reports collector liveness and cursor lag: tracked vs
 * undrained runs, audit row count, and the last completed cycle's stats.
 * It never echoes `WARREN_API_TOKEN` or any credential — the only string
 * it reports about warren is nothing at all.
 *
 * Auth: the surface is unauthenticated, matching what a third party can
 * build today — warren has no extension-auth contract to delegate to
 * (FRICTION §4). Operators front it with their own proxy.
 *
 * Retention caveat: pruning deletes the OLDEST rows, so a client whose
 * `since` cursor falls behind the retention horizon sees a gap, not an
 * error. That is inherent to an append-only log with retention; the
 * README's env contract says so.
 */

import type { AuditRow, AuditStore } from "./audit-store.ts";
import type { CursorStore } from "./cursor-store.ts";
import type { CycleStats } from "./collector.ts";

/** The health snapshot the collector loop publishes after each cycle. */
export interface HealthState {
	/** Stats from the last completed cycle, or null before the first. */
	lastCycle: CycleStats | null;
	/** ISO timestamp of the last completed cycle. */
	lastCycleAt: string | null;
	/** Message of the last cycle-level failure, or null. */
	lastCycleError: string | null;
	/** Boot time, for uptime. */
	readonly startedAt: Date;
}

export interface ExportServerDeps {
	readonly store: AuditStore;
	readonly cursors: CursorStore;
	readonly health: HealthState;
	readonly extensionName: string;
	readonly extensionVersion: string;
	/** 0 picks an ephemeral port (tests). */
	readonly port: number;
}

export type ExportServer = ReturnType<typeof Bun.serve>;

const DEFAULT_PAGE_LIMIT = 1000;
const MAX_PAGE_LIMIT = 10000;

function badRequest(message: string): Response {
	return Response.json({ error: message }, { status: 400 });
}

function serveAuditLog(store: AuditStore, url: URL): Response {
	const rawSince = url.searchParams.get("since") ?? "0";
	const since = Number.parseInt(rawSince, 10);
	if (!Number.isFinite(since) || since < 0 || String(since) !== rawSince) {
		return badRequest(`since must be a non-negative integer; got '${rawSince}'`);
	}
	const rawLimit = url.searchParams.get("limit");
	let limit = DEFAULT_PAGE_LIMIT;
	if (rawLimit !== null) {
		const parsed = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== rawLimit) {
			return badRequest(`limit must be a positive integer; got '${rawLimit}'`);
		}
		limit = Math.min(parsed, MAX_PAGE_LIMIT);
	}
	const rows: readonly AuditRow[] = store.rowsSince(since, limit);
	const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
	return new Response(body, {
		headers: {
			"content-type": "application/x-ndjson",
			"X-Audit-Log-Max-Id": String(store.maxId()),
		},
	});
}

function serveHealth(deps: Omit<ExportServerDeps, "port">): Response {
	const { health } = deps;
	const tracked = deps.cursors.trackedRuns();
	const undrained = deps.cursors.undrainedRuns();
	// Lag, as observable from inside the extension: runs not fully caught
	// up, rows stored so far, and how stale the last completed cycle is.
	// True server-side lag (events in warren not yet collected) is not
	// knowable without a global stream — FRICTION §1.
	const body = {
		status: health.lastCycleError === null ? "ok" : "degraded",
		extension: deps.extensionName,
		version: deps.extensionVersion,
		uptimeMs: Date.now() - health.startedAt.getTime(),
		auditRows: deps.store.count(),
		maxId: deps.store.maxId(),
		trackedRuns: tracked,
		undrainedRuns: undrained,
		lastCycle: health.lastCycle,
		lastCycleAt: health.lastCycleAt,
		lastCycleError: health.lastCycleError,
	};
	return Response.json(body);
}

/** Build the fetch handler; exported separately so tests can skip sockets. */
export function createFetchHandler(
	deps: Omit<ExportServerDeps, "port">,
): (req: Request) => Response {
	return (req) => {
		const url = new URL(req.url);
		if (req.method !== "GET") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		if (url.pathname === "/audit-log.jsonl") return serveAuditLog(deps.store, url);
		if (url.pathname === "/healthz") return serveHealth(deps);
		return Response.json({ error: "not found" }, { status: 404 });
	};
}

/** Serve the export surface until `stop()` is called. */
export function createExportServer(deps: ExportServerDeps): ExportServer {
	return Bun.serve({ port: deps.port, fetch: createFetchHandler(deps) });
}
