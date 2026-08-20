import { describe, expect, test } from "bun:test";
import { TrackerError } from "../../core/wire.ts";
import type { TrackerConfig } from "../../warren-config/schema.ts";
import { buildRemoteTracker, resolveTrackerBearer } from "./from-config.ts";
import { TRACKER_PROTOCOL_VERSION } from "./protocol.ts";

function startFake(
	routes: (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>,
): { baseUrl: string; stop: () => Promise<void> } {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const response = await routes(req, url);
			if (response !== undefined) return response;
			return Response.json({ error: { code: "no_route", message: "no route" } }, { status: 404 });
		},
	});
	return { baseUrl: `http://${server.hostname}:${server.port}`, stop: () => server.stop(true) };
}

function capabilitiesOk(): Response {
	return Response.json({
		protocolVersion: TRACKER_PROTOCOL_VERSION,
		capabilities: {
			supportsPlans: true,
			supportsMetadata: true,
			supportsScheduledIssues: true,
			isGitNative: false,
		},
	});
}

describe("buildRemoteTracker (config → bridge)", () => {
	const config: TrackerConfig = {
		url: "http://tracker.internal:8080",
		tokenEnv: "PROJ_TRACKER_TOKEN",
	};

	test("resolves the bearer from the operator environment", () => {
		expect(resolveTrackerBearer(config, { PROJ_TRACKER_TOKEN: "tok-abc" })).toBe("tok-abc");
	});

	test("no tokenEnv means no bearer", () => {
		expect(resolveTrackerBearer({ url: config.url }, {})).toBeUndefined();
	});

	test("a declared but unset tokenEnv fails loud", () => {
		expect(() => resolveTrackerBearer(config, {})).toThrow(TrackerError);
		expect(() => resolveTrackerBearer(config, { PROJ_TRACKER_TOKEN: "" })).toThrow(
			/PROJ_TRACKER_TOKEN.*not set/,
		);
	});

	test("builds an unconnected tracker carrying the bearer", async () => {
		let seenAuth: string | undefined;
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") {
				seenAuth = _req.headers.get("authorization") ?? undefined;
				return capabilitiesOk();
			}
			return undefined;
		});
		try {
			const tracker = buildRemoteTracker({
				config: { url: fake.baseUrl, tokenEnv: "PROJ_TRACKER_TOKEN" },
				env: { PROJ_TRACKER_TOKEN: "tok-xyz" },
			});
			const caps = await tracker.connect();
			expect(caps.supportsPlans).toBe(true);
			expect(seenAuth).toBe("Bearer tok-xyz");
		} finally {
			await fake.stop();
		}
	});
});
