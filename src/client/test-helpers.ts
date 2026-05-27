/**
 * Shared test fixtures for src/client/*.test.ts (warren-5b69 / pl-9088 step 11).
 *
 * The client suite was historically a single 993-line file; it was split into
 * several siblings (client.test.ts, client.projects-agents.test.ts,
 * client.probe.test.ts, client.runs.test.ts, client.stream.test.ts,
 * client.plots.test.ts, client.plan-runs.test.ts) to retire the
 * noExcessiveLinesPerFunction biome override. These helpers are the common
 * Response / fetch shims those siblings need.
 */

export function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}
