/* ----------------------------------------------------------------------- */
/* Instance facts — `GET /instance` (warren-2eec / pl-7e38 step 17).     */
/*                                                                       */
/* The body varies with `Authorization`: an operator gets the full        */
/* projection, a `WARREN_AUTH=public` spectator gets the reduced static   */
/* one (`version`, `name`, `publicUrl`, `runtime`, `authMode`). The       */
/* operator-only fields are therefore optional on the wire type, and the  */
/* Instance page renders them as a quiet "Operator only" when absent —    */
/* never fabricated. `name` / `publicUrl` (warren-a112) are optional only */
/* so older servers still type-check; current servers always send them.  */
/* ----------------------------------------------------------------------- */

export interface InstanceAdmissionFacts {
	maxQueueDepth: number;
	maxPendingPods: number;
	maxProjectConcurrency: number | null;
}

export interface InstanceFactsResponse {
	version: string;
	/** `WARREN_INSTANCE_NAME` display name (warren-a112); null when unset. */
	name?: string | null;
	/** Public UI base URL from server-side `WARREN_BASE_URL`; null when unset. */
	publicUrl?: string | null;
	runtime: "local" | "docker" | "k8s";
	authMode: "token" | "public";
	dbBackend?: "sqlite" | "postgres" | null;
	uptimeSeconds?: number;
	admission?: InstanceAdmissionFacts | null;
}
