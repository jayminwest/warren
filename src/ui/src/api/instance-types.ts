/* ----------------------------------------------------------------------- */
/* Instance facts — `GET /instance` (warren-2eec / pl-7e38 step 17).     */
/*                                                                       */
/* The body varies with `Authorization`: an operator gets the full        */
/* projection, a `WARREN_AUTH=public` spectator gets the reduced static   */
/* one (`version`, `runtime`, `authMode`). The operator-only fields are   */
/* therefore optional on the wire type, and the Instance page renders     */
/* them as quiet "—" placeholders when absent — never fabricated.         */
/* ----------------------------------------------------------------------- */

export interface InstanceAdmissionFacts {
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
	admission?: InstanceAdmissionFacts | null;
}
