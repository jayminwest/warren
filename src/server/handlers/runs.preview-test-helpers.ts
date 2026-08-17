import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import type { PreviewAuth } from "../../preview/cookie.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

export const TOKEN = "test-token-very-secret-1234567890abcdef";
export const HOST = "preview.warren.example.com";

export const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

/** An inert provider — the preview handlers never reach the runtime seam. */
export function makeSandboxClient(): FakeProvider {
	return new FakeProvider();
}

export async function depsFor(
	repos: Repos,
	previewAuth: PreviewAuth | undefined,
	db?: AnyWarrenDb,
	previewMode: "subdomain" | "path" = "subdomain",
): Promise<{ deps: ServerDeps; bridges: BridgeRegistry }> {
	const provider = makeSandboxClient();
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		runtimeProvider: provider,
		bridge: async () => ({ written: 0, skipped: 0, errored: false }),
	});
	const previewExtras =
		previewAuth === undefined
			? {}
			: previewMode === "path"
				? { previewAuth, previewMode: "path" as const }
				: { previewAuth, previewMode: "subdomain" as const, previewHost: HOST };
	const deps: ServerDeps = {
		repos,
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(db !== undefined ? { db, ...createDbSeams(db) } : {}),
		...previewExtras,
	};
	return { deps, bridges };
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}
