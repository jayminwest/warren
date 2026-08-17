import type { Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

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
	_extras?: Record<string, never>,
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
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}
