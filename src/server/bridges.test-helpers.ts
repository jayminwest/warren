import { BurrowClient } from "../burrow-client/index.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunTerminalState } from "../db/schema.ts";
import type { ReapRunResult } from "../runs/index.ts";
import { makeReapRunResult } from "../runs/reap/test-helpers.ts";

/**
 * Shared fixtures for the stream-bridge registry tests (`bridges.test.ts`)
 * and the reconnect/stall tests (`bridge-reconnect.test.ts`). Extracted so
 * both suites share one stub burrow client without tripping the duplicate
 * scanner (warren-61e9).
 */

/**
 * Historical one-worker pool wrapper (warren-c0c9). Placement + the
 * workers/burrows tables were retired (warren-76c5 / warren-3743), so this is
 * now a pass-through kept for call-site stability; the `_repos` param is
 * vestigial.
 */
export async function makePool(
	_repos: Repos,
	client?: BurrowClient,
	_workerName = "local",
): Promise<BurrowClient> {
	return client ?? makeBurrowClient();
}

export function reapStub(outcome: RunTerminalState): ReapRunResult {
	return makeReapRunResult({ state: outcome });
}

export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

/**
 * Default stub burrow client: returns a synthetic `running` row for any
 * `GET /runs/:id` (so warren-b1a9's bootBridges pre-probe passes) and 404
 * for everything else. Tests exercising the ghost-run reconciler build
 * their own client that 404s on the run-get instead.
 */
export function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const method = init?.method ?? "GET";
			if (method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
				return new Response(
					JSON.stringify({
						id: "stub_run",
						burrowId: "bur_a",
						agentId: "refactor-bot",
						prompt: "p",
						resumeOfRunId: null,
						state: "running",
						exitCode: null,
						errorMessage: null,
						metadataJson: null,
						queuedAt: new Date("2026-05-17T19:00:00Z").toISOString(),
						startedAt: new Date("2026-05-17T19:00:01Z").toISOString(),
						completedAt: null,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ error: { code: "not_found", message: "stub" } }), {
				status: 404,
			});
		}),
	});
}
