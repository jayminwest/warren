import type { Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

/**
 * Shared test helpers and stubs for run-related handler tests (warren-6566).
 */

export const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

/**
 * Recording logger with pino-style `child` binding merge (warren-9ce3).
 * Use to assert dispatch provenance (`dispatch_origin`, `dispatcher_handle`)
 * rides onto spawn log lines from HTTP call sites that go through real
 * `spawnRun` rather than a stubbed `spawnRunFn`.
 */
export function makeRecordingLogger(bound: Record<string, unknown> = {}): {
	logger: {
		info(obj: object, msg?: string): void;
		warn(obj: object, msg?: string): void;
		error(obj: object, msg?: string): void;
		child(extra: object): unknown;
	};
	lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }>;
} {
	const lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
	const merge = (bindings: Record<string, unknown>, obj: object) => ({
		...bindings,
		...(obj as Record<string, unknown>),
	});
	const make = (bindings: Record<string, unknown>) => ({
		info: (obj: object, msg?: string) =>
			lines.push({ level: "info", obj: merge(bindings, obj), msg }),
		warn: (obj: object, msg?: string) =>
			lines.push({ level: "warn", obj: merge(bindings, obj), msg }),
		error: (obj: object, msg?: string) =>
			lines.push({ level: "error", obj: merge(bindings, obj), msg }),
		child: (extra: object) => make(merge(bindings, extra)),
	});
	return { logger: make(bound), lines };
}

export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

export interface BurrowFixture {
	sandboxId: string;
	sandboxRunId: string;
	workspacePath: string;
}

/**
 * The provider fake the handler tests dispatch through (warren-ea0a). The
 * fixture keeps the historical field names — the recorded calls and the
 * returned handle ids are the same ones the retired burrow stub produced,
 * so the assertions that pin the provider-boundary payloads read unchanged.
 */
export function makeSandboxClient(
	fix: BurrowFixture,
	calls: { method: string; path: string; body: unknown }[],
): FakeProvider {
	return new FakeProvider(
		{
			sandboxId: fix.sandboxId,
			providerRunId: fix.sandboxRunId,
			workspacePath: fix.workspacePath,
		},
		undefined,
		calls,
	);
}

export async function depsFor(
	repos: Repos,
	provider: FakeProvider,
	bridges?: BridgeRegistry,
	extras?: {
		finalizeCoordinator?: import("../../runtime/k8s/finalize-coordinator.ts").FinalizeCoordinator;
		/** Event-stream concurrency caps (warren-25f6). Omitted ⇒ uncapped. */
		streamLimiter?: import("../stream-limits.ts").EventStreamLimiter;
		/** Salvage-bundle intake dir (warren-cd3b). Omitted ⇒ the route 500s. */
		salvageDir?: string;
	},
): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	return {
		repos,
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges:
			bridges ??
			createBridgeRegistry({
				repos,
				broker,
				runtimeProvider: provider,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
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
		...(extras?.salvageDir !== undefined ? { salvageDir: extras.salvageDir } : {}),
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}
