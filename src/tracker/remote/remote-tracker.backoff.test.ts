import { describe, expect, test } from "bun:test";
import { type TrackerContext, TrackerError } from "../../core/wire.ts";
import { TRACKER_PROTOCOL_VERSION } from "./protocol.ts";
import { RemoteTracker } from "./remote-tracker.ts";

const CTX: TrackerContext = { projectId: "proj-1" };

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

const FULL_CAPS = {
	protocolVersion: TRACKER_PROTOCOL_VERSION,
	capabilities: {
		supportsPlans: true,
		supportsMetadata: true,
		supportsScheduledIssues: true,
		isGitNative: false,
	},
};

function capabilitiesOk(): Response {
	return Response.json(FULL_CAPS);
}

function issue(id: string, status: string): Response {
	return Response.json({ id, status, title: `t-${id}` });
}

describe("RemoteTracker backoff", () => {
	test("retries a 5xx and succeeds once the server recovers", async () => {
		let failures = 0;
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") return capabilitiesOk();
			if (url.pathname === "/issues/warren-a") {
				if (failures < 2) {
					failures += 1;
					return Response.json({ error: { code: "boom", message: "upstream" } }, { status: 503 });
				}
				return issue("warren-a", "open");
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				cacheTtlMs: 0,
				initialBackoffMs: 1,
			});
			await tracker.connect();
			const issueResult = await tracker.getIssue(CTX, "warren-a");
			expect(issueResult.id).toBe("warren-a");
			expect(failures).toBe(2);
		} finally {
			await fake.stop();
		}
	});

	test("gives up after maxAttempts and reports the last status", async () => {
		let hits = 0;
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") return capabilitiesOk();
			if (url.pathname === "/issue-statuses") {
				hits += 1;
				return new Response("too many", {
					status: 429,
					headers: { "retry-after": "0" },
				});
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				cacheTtlMs: 0,
				maxAttempts: 3,
				initialBackoffMs: 1,
			});
			await tracker.connect();
			await expect(tracker.listIssueStatuses(CTX)).rejects.toThrow(/after 3 attempts.*429/);
			expect(hits).toBe(3);
		} finally {
			await fake.stop();
		}
	});

	test("a 400-class answer is final — no retry", async () => {
		let hits = 0;
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") return capabilitiesOk();
			if (url.pathname === "/issue-statuses") {
				hits += 1;
				return Response.json({ error: { code: "bad_request", message: "nope" } }, { status: 400 });
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				cacheTtlMs: 0,
				initialBackoffMs: 1,
			});
			await tracker.connect();
			await expect(tracker.listIssueStatuses(CTX)).rejects.toBeInstanceOf(TrackerError);
			expect(hits).toBe(1);
		} finally {
			await fake.stop();
		}
	});
});
