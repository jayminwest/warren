/**
 * RemoteTracker tests against an in-process fake warren-tracker/v1
 * server (warren-d3a9). The fake here is deliberately minimal — the
 * full FakeTracker reference server + conformance suite is warren-53ea;
 * these tests pin the bridge's own behavior: version negotiation,
 * capability gating, error taxonomy, the read TTL cache, and backoff.
 */

import { describe, expect, test } from "bun:test";
import { IssueNotFoundError, type TrackerContext, TrackerError } from "../../core/wire.ts";
import { TRACKER_PROTOCOL_VERSION } from "./protocol.ts";
import { RemoteTracker } from "./remote-tracker.ts";

const CTX: TrackerContext = { projectId: "proj-1" };

/** Minimal in-process fake: routes + per-test mutable state. */
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

/** A fake serving the whole protocol from a mutable in-memory issue set. */
interface FakeState {
	issues: Map<string, string>;
	requests: { method: string; path: string; auth?: string | null }[];
}

function fullFake(state: FakeState) {
	return (req: Request, url: URL): Response | undefined => {
		state.requests.push({
			method: req.method,
			path: url.pathname,
			auth: req.headers.get("authorization"),
		});
		if (url.pathname === "/capabilities") return capabilitiesOk();
		const close = /^\/issues\/([^/]+)\/close$/.exec(url.pathname);
		if (close !== null) return closeRoute(state, decodeURIComponent(close[1] ?? ""));
		const show = /^\/issues\/([^/]+)$/.exec(url.pathname);
		if (show !== null && req.method === "GET") {
			return showRoute(state, decodeURIComponent(show[1] ?? ""));
		}
		if (url.pathname === "/issue-statuses") return statusesRoute(state);
		return undefined;
	};
}

function showRoute(state: FakeState, id: string): Response {
	if (!state.issues.has(id)) {
		return Response.json(
			{ error: { code: "issue_not_found", message: `no such issue ${id}` } },
			{ status: 404 },
		);
	}
	return issue(id, state.issues.get(id) ?? "open");
}

function closeRoute(state: FakeState, id: string): Response {
	if (!state.issues.has(id)) {
		return Response.json(
			{ error: { code: "issue_not_found", message: `no such issue ${id}` } },
			{ status: 404 },
		);
	}
	state.issues.set(id, "closed"); // idempotent: closing again is fine
	return new Response(null, { status: 204 });
}

function statusesRoute(state: FakeState): Response {
	const statuses: Record<string, string> = {};
	for (const [id, status] of state.issues) statuses[id] = status;
	return Response.json({ statuses });
}

function plansListResponse(): Response {
	return Response.json({
		plans: [
			{
				id: "pl-1",
				status: "active",
				childCount: 2,
				name: "the plan",
				createdAt: "2026-08-01T00:00:00Z",
			},
		],
	});
}

function planShowResponse(): Response {
	return Response.json({
		id: "pl-1",
		status: "active",
		children: ["warren-a", "warren-b"],
		steps: [{ title: "first", blocks: [1] }, { existingSeed: "warren-z" }],
	});
}

async function metadataCaptureResponse(req: Request, bodies: unknown[]): Promise<Response> {
	bodies.push(await req.json());
	return new Response(null, { status: 204 });
}

function scheduledIssuesResponse(): Response {
	return Response.json({
		issues: [{ id: "warren-a", status: "open", scheduledFor: "2026-09-01T12:00:00Z" }],
	});
}

describe("RemoteTracker.connect", () => {
	test("adopts the remote's capabilities on a matching protocol version", async () => {
		const fake = startFake(() => capabilitiesOk());
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			const caps = await tracker.connect();
			expect(caps).toEqual({
				supportsPlans: true,
				supportsMetadata: true,
				supportsScheduledIssues: true,
				isGitNative: false,
			});
			expect(tracker.capabilities).toEqual(caps);
		} finally {
			await fake.stop();
		}
	});

	test("fails loud on a protocol version mismatch", async () => {
		const fake = startFake(() =>
			Response.json({
				protocolVersion: "warren-tracker/v2",
				capabilities: FULL_CAPS.capabilities,
			}),
		);
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl });
			await expect(tracker.connect()).rejects.toBeInstanceOf(TrackerError);
			await expect(tracker.connect()).rejects.toThrow(/warren-tracker\/v2/);
		} finally {
			await fake.stop();
		}
	});

	test("fails on a malformed capabilities payload", async () => {
		const fake = startFake(() => Response.json({ hello: "world" }));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl });
			await expect(tracker.connect()).rejects.toThrow(/malformed capabilities/);
		} finally {
			await fake.stop();
		}
	});

	test("operations on an unconnected tracker throw instead of guessing", async () => {
		const fake = startFake(() => capabilitiesOk());
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl });
			await expect(tracker.getIssue(CTX, "warren-a")).rejects.toThrow(/connect/);
		} finally {
			await fake.stop();
		}
	});
});

describe("RemoteTracker base contract", () => {
	test("getIssue maps the wire payload and normalizes raw statuses", async () => {
		const state: FakeState = { issues: new Map([["warren-a", "in_progress"]]), requests: [] };
		const fake = startFake(fullFake(state));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			const issue = await tracker.getIssue(CTX, "warren-a");
			expect(issue.id).toBe("warren-a");
			expect(issue.status).toBe("other");
			expect(issue.title).toBe("t-warren-a");
		} finally {
			await fake.stop();
		}
	});

	test("getIssue maps a 404 issue_not_found onto IssueNotFoundError", async () => {
		const state: FakeState = { issues: new Map(), requests: [] };
		const fake = startFake(fullFake(state));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			await expect(tracker.getIssue(CTX, "warren-missing")).rejects.toBeInstanceOf(
				IssueNotFoundError,
			);
		} finally {
			await fake.stop();
		}
	});

	test("getIssue maps a reserved error code on a 500 body onto IssueNotFoundError", async () => {
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") return capabilitiesOk();
			if (url.pathname === "/issues/warren-x") {
				return Response.json(
					{ error: { code: "issue_not_found", message: "gone" } },
					{ status: 502 },
				);
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0, maxAttempts: 1 });
			await tracker.connect();
			await expect(tracker.getIssue(CTX, "warren-x")).rejects.toBeInstanceOf(IssueNotFoundError);
		} finally {
			await fake.stop();
		}
	});

	test("listIssueStatuses returns a normalized id→status map", async () => {
		const state: FakeState = {
			issues: new Map([
				["warren-a", "open"],
				["warren-b", "closed"],
				["warren-c", "in_review"],
			]),
			requests: [],
		};
		const fake = startFake(fullFake(state));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			const statuses = await tracker.listIssueStatuses(CTX);
			expect(Object.fromEntries(statuses)).toEqual({
				"warren-a": "open",
				"warren-b": "closed",
				"warren-c": "other",
			});
		} finally {
			await fake.stop();
		}
	});

	test("closeIssue is idempotent and invalidates the read cache", async () => {
		const state: FakeState = {
			issues: new Map([
				["warren-a", "open"],
				["warren-b", "closed"],
			]),
			requests: [],
		};
		const fake = startFake(fullFake(state));
		try {
			let tick = 1000;
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				cacheTtlMs: 60_000,
				now: () => tick,
			});
			await tracker.connect();
			expect((await tracker.getIssue(CTX, "warren-a")).status).toBe("open");
			// cached: same issue, no new request
			const before = state.requests.filter((r) => r.path === "/issues/warren-a").length;
			await tracker.getIssue(CTX, "warren-a");
			expect(state.requests.filter((r) => r.path === "/issues/warren-a").length).toBe(before);
			// closing an already-closed issue is a success
			await tracker.closeIssue(CTX, "warren-b");
			await tracker.closeIssue(CTX, "warren-a");
			expect(state.issues.get("warren-a")).toBe("closed");
			// the write invalidated the cache
			tick += 1;
			expect((await tracker.getIssue(CTX, "warren-a")).status).toBe("closed");
		} finally {
			await fake.stop();
		}
	});

	test("sends the bearer token on every request when configured", async () => {
		const state: FakeState = { issues: new Map([["warren-a", "open"]]), requests: [] };
		const fake = startFake(fullFake(state));
		try {
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				bearerToken: "tok-1",
				cacheTtlMs: 0,
			});
			await tracker.connect();
			await tracker.getIssue(CTX, "warren-a");
			expect(state.requests.every((r) => r.auth === "Bearer tok-1")).toBe(true);
		} finally {
			await fake.stop();
		}
	});
});

describe("RemoteTracker read cache", () => {
	test("a cached read survives until the TTL expires, then re-fetches", async () => {
		const state: FakeState = { issues: new Map([["warren-a", "open"]]), requests: [] };
		const fake = startFake(fullFake(state));
		try {
			let tick = 1000;
			const tracker = new RemoteTracker({
				baseUrl: fake.baseUrl,
				cacheTtlMs: 5000,
				now: () => tick,
			});
			await tracker.connect();
			await tracker.getIssue(CTX, "warren-a");
			await tracker.getIssue(CTX, "warren-a");
			expect(state.requests.filter((r) => r.path === "/issues/warren-a").length).toBe(1);
			tick += 5001; // expire
			await tracker.getIssue(CTX, "warren-a");
			expect(state.requests.filter((r) => r.path === "/issues/warren-a").length).toBe(2);
		} finally {
			await fake.stop();
		}
	});

	test("cache keys are per-project", async () => {
		const state: FakeState = { issues: new Map([["warren-a", "open"]]), requests: [] };
		const fake = startFake(fullFake(state));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 60_000 });
			await tracker.connect();
			await tracker.getIssue(CTX, "warren-a");
			await tracker.getIssue({ projectId: "proj-2" }, "warren-a");
			expect(state.requests.filter((r) => r.path === "/issues/warren-a").length).toBe(2);
		} finally {
			await fake.stop();
		}
	});
});

describe("RemoteTracker optional surfaces", () => {
	test("gates plans/metadata/scheduled on the declared capabilities without HTTP", async () => {
		const state: FakeState = { issues: new Map(), requests: [] };
		const fake = startFake(async (req, url) => {
			state.requests.push({ method: req.method, path: url.pathname });
			if (url.pathname === "/capabilities") {
				return Response.json({
					protocolVersion: TRACKER_PROTOCOL_VERSION,
					capabilities: {
						supportsPlans: false,
						supportsMetadata: false,
						supportsScheduledIssues: false,
						isGitNative: false,
					},
				});
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			await expect(tracker.listPlans(CTX)).rejects.toThrow(/does not support plans/);
			await expect(tracker.getPlan(CTX, "pl-1")).rejects.toThrow(/does not support plans/);
			await expect(tracker.mergeIssueMetadata(CTX, "i", { a: 1 })).rejects.toThrow(
				/does not support metadata/,
			);
			await expect(tracker.listScheduledIssues(CTX)).rejects.toThrow(/does not support scheduled/);
			expect(state.requests).toHaveLength(1); // capabilities only
		} finally {
			await fake.stop();
		}
	});

	test("serves plans, metadata merges, and scheduled issues when declared", async () => {
		const bodies: unknown[] = [];
		const routes: Record<string, (req: Request) => Response | Promise<Response>> = {
			"/capabilities": () => capabilitiesOk(),
			"/plans": plansListResponse,
			"/plans/pl-1": planShowResponse,
			"/issues/warren-a/metadata": (req) => metadataCaptureResponse(req, bodies),
			"/scheduled-issues": scheduledIssuesResponse,
		};
		const fake = startFake((req, url) => routes[url.pathname]?.(req));
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			const plans = await tracker.listPlans(CTX);
			expect(plans).toEqual([
				{
					id: "pl-1",
					status: "active",
					childCount: 2,
					name: "the plan",
					createdAt: "2026-08-01T00:00:00Z",
				},
			]);
			const plan = await tracker.getPlan(CTX, "pl-1");
			expect(plan.children).toEqual(["warren-a", "warren-b"]);
			expect(plan.steps).toEqual([{ title: "first", blocks: [1] }, { existingSeed: "warren-z" }]);
			await tracker.mergeIssueMetadata(CTX, "warren-a", { role: "planner" });
			expect(bodies).toEqual([{ metadata: { role: "planner" } }]);
			const scheduled = await tracker.listScheduledIssues(CTX);
			expect(scheduled[0]?.scheduledFor).toEqual(new Date("2026-09-01T12:00:00Z"));
		} finally {
			await fake.stop();
		}
	});

	test("rejects an unknown plan status instead of guessing", async () => {
		const fake = startFake((_req, url) => {
			if (url.pathname === "/capabilities") return capabilitiesOk();
			if (url.pathname === "/plans/pl-1") {
				return Response.json({ id: "pl-1", status: "weird", children: [] });
			}
			return undefined;
		});
		try {
			const tracker = new RemoteTracker({ baseUrl: fake.baseUrl, cacheTtlMs: 0 });
			await tracker.connect();
			await expect(tracker.getPlan(CTX, "pl-1")).rejects.toThrow(/unknown plan status "weird"/);
		} finally {
			await fake.stop();
		}
	});
});
