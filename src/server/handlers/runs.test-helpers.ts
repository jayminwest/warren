import { BurrowClient } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { resolveRuntimeProvider } from "../../runtime/registry.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

/**
 * Shared test helpers and stubs for run-related handler tests (warren-6566).
 */

export async function poolFor(_repos: Repos, client: BurrowClient): Promise<BurrowClient> {
	return client;
}

export const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

export interface BurrowFixture {
	burrowId: string;
	burrowRunId: string;
	workspacePath: string;
}

export function makeBurrowClient(
	fix: BurrowFixture,
	calls: { method: string; path: string; body: unknown }[],
): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path, body: reqBody });
			if (method === "POST" && path === "/burrows") {
				const burrow = {
					id: fix.burrowId,
					name: "burrow",
					kind: "task",
					projectRoot: "/data/projects/x/y",
					branch: "main",
					baseBranch: "main",
					originUrl: "https://github.com/x/y.git",
					workspacePath: fix.workspacePath,
					provider: "local",
					sandbox: { network: "open" },
					state: "running",
					createdAt: "2026-05-08T12:00:00Z",
					updatedAt: "2026-05-08T12:00:00Z",
				};
				return new Response(JSON.stringify(burrow), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "POST" && path === `/burrows/${fix.burrowId}/runs`) {
				const run = {
					id: fix.burrowRunId,
					burrowId: fix.burrowId,
					agentId: "refactor-bot",
					prompt: "hello",
					resumeOfRunId: null,
					state: "queued",
					exitCode: null,
					errorMessage: null,
					metadataJson: null,
					queuedAt: "2026-05-08T12:00:01Z",
					startedAt: null,
					completedAt: null,
				};
				return new Response(JSON.stringify(run), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: `unmatched ${method} ${path}` } }),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	});
}

export async function depsFor(
	repos: Repos,
	burrowClient: BurrowClient,
	bridges?: BridgeRegistry,
	extras?: {
		finalizeCoordinator?: import("../../runtime/k8s/finalize-coordinator.ts").FinalizeCoordinator;
		/** Event-stream concurrency caps (warren-25f6). Omitted ⇒ uncapped. */
		streamLimiter?: import("../stream-limits.ts").EventStreamLimiter;
	},
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	await poolFor(repos, burrowClient);
	return {
		repos,
		runtimeProvider: resolveRuntimeProvider({ burrowClient: () => burrowClient }),
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				runtimeProvider: resolveRuntimeProvider({ burrowClient: () => burrowClient }),
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		canopyConfig: {
			repoUrl: "https://example/agents.git",
			localDir: "/tmp/cn",
			cnBinary: "cn",
			gitBinary: "git",
		},
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		// No-op spawn so the project-refresh path inside `POST /runs` and
		// `POST /projects/:id/refresh` doesn't shell out to real `git`
		// against tmpdir paths the test never populated. Tests that need
		// to assert on spawn calls override `deps.spawn` directly.
		spawn: async (cmd) => {
			if (cmd[1] === "rev-parse") {
				return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		...(extras?.finalizeCoordinator !== undefined
			? { finalizeCoordinator: extras.finalizeCoordinator }
			: {}),
		...(extras?.streamLimiter !== undefined ? { streamLimiter: extras.streamLimiter } : {}),
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}
