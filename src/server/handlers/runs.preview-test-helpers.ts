import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewAuth } from "../../preview/cookie.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, ServeHandle, ServerDeps } from "../types.ts";

export const TOKEN = "test-token-very-secret-1234567890abcdef";
export const HOST = "preview.warren.example.com";

export const silentLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

export function makeBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch,
	});
}

export async function depsFor(
	repos: Repos,
	previewAuth: PreviewAuth | undefined,
	db?: AnyWarrenDb,
	previewMode: "subdomain" | "path" = "subdomain",
): Promise<{ deps: ServerDeps; bridges: BridgeRegistry }> {
	const client = makeBurrowClient();
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const burrowClientPool = new BurrowClientPool({ repos });
	burrowClientPool.register("local", client);
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		burrowClientPool,
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
		burrowClientPool,
		broker,
		bridges,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(db !== undefined ? { db } : {}),
		...previewExtras,
	};
	return { deps, bridges };
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}
