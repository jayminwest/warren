import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KubeConfig, Log, Watch } from "@kubernetes/client-node";
import { makeLogFollow } from "./log-follow.ts";
import type { LogFollowParams } from "./log-stream.ts";

const servers: Server[] = [];

function kubeConfig(server: string): KubeConfig {
	const config = new KubeConfig();
	config.loadFromOptions({
		clusters: [{ name: "test", server, skipTLSVerify: true }],
		users: [{ name: "test" }],
		contexts: [{ name: "test", cluster: "test", user: "test" }],
		currentContext: "test",
	});
	return config;
}

async function listen(
	handler: (url: URL, response: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((request, response) => {
		handler(new URL(request.url ?? "/", "http://127.0.0.1"), response);
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("timed out waiting for client-node stream activity");
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

const LOG_PARAMS: LogFollowParams = {
	namespace: "warren-runs",
	podName: "run-test",
	containerName: "agent",
	follow: true,
	timestamps: true,
};

describe("@kubernetes/client-node stream compatibility", () => {
	test("Log v2 delivers undici response chunks and cancels cleanly", async () => {
		let requestUrl: URL | undefined;
		const { baseUrl } = await listen((url, response) => {
			requestUrl = url;
			response.writeHead(200, { "content-type": "text/plain" });
			response.write('2026-08-25T00:00:00.000000000Z {"kind":"started"}\n');
		});
		const chunks: string[] = [];
		let doneCount = 0;
		let endError: unknown = "not-done";
		const controller = await makeLogFollow(new Log(kubeConfig(baseUrl)))(
			LOG_PARAMS,
			(chunk) => chunks.push(chunk),
			(error) => {
				doneCount += 1;
				endError = error;
			},
		);

		await waitFor(() => chunks.length > 0);
		expect(chunks.join("")).toContain('{"kind":"started"}');
		expect(requestUrl?.pathname).toBe("/api/v1/namespaces/warren-runs/pods/run-test/log");
		expect(requestUrl?.searchParams.get("container")).toBe("agent");
		expect(requestUrl?.searchParams.get("follow")).toBe("true");
		expect(requestUrl?.searchParams.get("timestamps")).toBe("true");

		controller.abort();
		await waitFor(() => doneCount === 1);
		expect(endError).toBeUndefined();
	});

	test("Watch v2 parses undici response lines and aborts through its controller", async () => {
		let requestUrl: URL | undefined;
		const { baseUrl } = await listen((url, response) => {
			requestUrl = url;
			response.writeHead(200, { "content-type": "application/json" });
			response.write(
				`${JSON.stringify({
					type: "ADDED",
					object: { metadata: { name: "run-test", resourceVersion: "8" } },
				})}\n`,
			);
		});
		const events: Array<{ phase: string; name: string | undefined }> = [];
		let doneCount = 0;
		let doneError: unknown;
		const watch = new Watch(kubeConfig(baseUrl));
		const controller = await watch.watch(
			"/api/v1/namespaces/warren-runs/pods",
			{ resourceVersion: "7", allowWatchBookmarks: true },
			(phase, object: { metadata?: { name?: string } }) => {
				events.push({ phase, name: object.metadata?.name });
			},
			(error) => {
				doneCount += 1;
				doneError = error;
			},
		);

		await waitFor(() => events.length === 1);
		expect(events).toEqual([{ phase: "ADDED", name: "run-test" }]);
		expect(requestUrl?.pathname).toBe("/api/v1/namespaces/warren-runs/pods");
		expect(requestUrl?.searchParams.get("watch")).toBe("true");
		expect(requestUrl?.searchParams.get("resourceVersion")).toBe("7");

		controller.abort();
		await waitFor(() => doneCount === 1);
		// v2 closes Readable.fromWeb cleanly before its abort error reaches `done`.
		expect(doneError).toBeNull();
	});
});
