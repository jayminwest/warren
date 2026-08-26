/**
 * Wire envelope of `GET /instance` (warren-2eec / pl-7e38 step 17) — the
 * read-only boot facts allowlist (src/instance/facts.ts). Split from
 * types.ts to respect its frozen line budget.
 */

/**
 * Auth mode resolved at boot (`resolveAuthKind`, src/server/auth.ts).
 * Echoed verbatim over the wire by the instance facts endpoint.
 */
export type InstanceAuthMode = "token" | "public";

/**
 * Wire envelope of `GET /instance` — the read-only boot facts allowlist
 * (src/instance/facts.ts). An operator gets the full projection; a
 * `WARREN_AUTH=public` spectator gets the reduced static projection, so
 * `dbBackend`, `uptimeSeconds`, and `admission` are optional fields only
 * the operator body carries. Never secrets or connection strings.
 */
export interface InstanceFactsResponse {
	version: string;
	runtime: string;
	authMode: InstanceAuthMode;
	dbBackend?: "sqlite" | "postgres" | null;
	uptimeSeconds?: number;
	admission?: {
		maxQueueDepth: number;
		maxPendingPods: number;
		maxProjectConcurrency: number | null;
	} | null;
}
