/**
 * Wire envelope of `GET /instance` (warren-2eec): boot-resolved instance
 * facts. Lives beside `./types.ts` (which is at its file-size budget) the
 * same way `./run-analytics-types.ts` does — UI-local because the server's
 * type lives in `src/instance/facts.ts`, which the browser bundle cannot
 * import.
 *
 * Spectators get a reduced projection (version / runtime / authMode only —
 * `src/instance/facts.ts`); the fields below are the superset an operator
 * can see, so treat every operator-only field as potentially undefined
 * when rendering public surfaces. The Dispatch page reads only `runtime`
 * and `admission`, both present in both projections.
 */

export interface InstanceAdmissionFactsResponse {
	maxQueueDepth: number;
	maxPendingPods: number;
	maxProjectConcurrency: number | null;
}

export interface InstanceFactsResponse {
	version: string;
	runtime: "local" | "docker" | "k8s";
	authMode: "token" | "public";
	dbBackend?: "sqlite" | "postgres" | null;
	uptimeSeconds?: number;
	admission?: InstanceAdmissionFactsResponse | null;
}
