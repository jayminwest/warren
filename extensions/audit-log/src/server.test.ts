/**
 * Tests for the export and health surface (step 4, warren-9c7c).
 *
 * The load-bearing assertions: `?since` pages the append-only log with no
 * skips and no duplicates across page boundaries, and /healthz reports
 * cursor lag without echoing credentials.
 */

import { describe, expect, test } from "bun:test";
import { AuditStore, type AuditRow } from "./audit-store.ts";
import { CursorStore } from "./cursor-store.ts";
import type { RunEvent } from "./wire.ts";
import { createFetchHandler, type HealthState } from "./server.ts";

function makeDeps(rowCount: number): {
	store: AuditStore;
	cursors: CursorStore;
	fetch: (req: Request) => Response;
	health: HealthState;
} {
	const store = new AuditStore(":memory:", { now: () => new Date("2026-08-05T00:00:00Z") });
	// One event per run yields two rows each (run.dispatched + run.started).
	for (let i = 1; i <= rowCount; i++) {
		const event: RunEvent = {
			id: i,
			runId: `run-${i}`,
			seq: i,
			ts: `2026-08-05T00:00:${String(i).padStart(2, "0")}Z`,
			kind: "message",
			stream: "system",
			payload: { line: `line ${i}` },
		};
		store.apply(event);
	}
	const cursors = new CursorStore(":memory:");
	const health: HealthState = {
		lastCycle: { runsDiscovered: 3, runsTailed: 2, eventsApplied: 7 },
		lastCycleAt: "2026-08-05T00:01:00Z",
		lastCycleError: null,
		startedAt: new Date(Date.now() - 5000),
	};
	const fetch = createFetchHandler({
		store,
		cursors,
		health,
		extensionName: "audit-log",
		extensionVersion: "0.0.0",
	});
	return { store, cursors, fetch, health };
}

async function getJsonl(fetch: (req: Request) => Response, path: string): Promise<AuditRow[]> {
	const res = fetch(new Request(`http://test${path}`));
	expect(res.status).toBe(200);
	const text = await res.text();
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditRow);
}

describe("GET /audit-log.jsonl", () => {
	test("exports every row oldest-first as NDJSON", async () => {
		const { fetch } = makeDeps(5);
		const rows = await getJsonl(fetch, "/audit-log.jsonl");
		expect(rows.length).toBe(10);
		expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(rows[0]?.runId).toBe("run-1");
		expect(rows[0]?.event).toBe("run.dispatched");
	});

	test("?since is exclusive and pages with no skips and no duplicates", async () => {
		const { fetch } = makeDeps(10);
		const seen: number[] = [];
		let since = 0;
		while (true) {
			const page = await getJsonl(fetch, `/audit-log.jsonl?since=${since}&limit=3`);
			if (page.length === 0) break;
			seen.push(...page.map((r) => r.id));
			since = page[page.length - 1]?.id ?? since;
		}
		expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	});

	test("X-Audit-Log-Max-Id lets an empty page checkpoint", async () => {
		const { fetch } = makeDeps(4);
		const res = fetch(new Request("http://test/audit-log.jsonl?since=8"));
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Audit-Log-Max-Id")).toBe("8");
		expect(await res.text()).toBe("");
	});

	test("rejects a malformed since or limit with 400", () => {
		const { fetch } = makeDeps(1);
		expect(fetch(new Request("http://test/audit-log.jsonl?since=abc")).status).toBe(400);
		expect(fetch(new Request("http://test/audit-log.jsonl?since=-1")).status).toBe(400);
		expect(fetch(new Request("http://test/audit-log.jsonl?limit=0")).status).toBe(400);
	});

	test("caps limit at the server maximum", async () => {
		const { fetch } = makeDeps(3);
		const res = fetch(new Request("http://test/audit-log.jsonl?limit=999999"));
		expect(res.status).toBe(200);
		const rows = (await res.text()).trim().split("\n");
		expect(rows.length).toBe(6);
	});
});

describe("GET /healthz", () => {
	test("reports cursor lag and liveness without credentials", async () => {
		const { fetch, cursors } = makeDeps(3);
		cursors.checkpoint("run-1", 5, "completed", true, "2026-08-05T00:00:30Z");
		cursors.checkpoint("run-2", 2, "running", false, "2026-08-05T00:00:40Z");
		const res = fetch(new Request("http://test/healthz"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.extension).toBe("audit-log");
		expect(body.auditRows).toBe(6);
		expect(body.maxId).toBe(6);
		expect(body.trackedRuns).toBe(2);
		expect(body.undrainedRuns).toBe(1);
		expect(body.lastCycle).toEqual({ runsDiscovered: 3, runsTailed: 2, eventsApplied: 7 });
		expect(body.lastCycleAt).toBe("2026-08-05T00:01:00Z");
		expect(typeof body.uptimeMs).toBe("number");
		// No credential material anywhere in the body.
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("token");
		expect(raw).not.toContain("Bearer");
	});

	test("reports degraded after a cycle failure", async () => {
		const { fetch, health } = makeDeps(0);
		health.lastCycleError = "connect ECONNREFUSED";
		const res = fetch(new Request("http://test/healthz"));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("degraded");
		expect(body.lastCycleError).toBe("connect ECONNREFUSED");
	});
});

describe("routing", () => {
	test("unknown paths 404 and non-GET methods 405", () => {
		const { fetch } = makeDeps(0);
		expect(fetch(new Request("http://test/nope")).status).toBe(404);
		expect(fetch(new Request("http://test/healthz", { method: "POST" })).status).toBe(405);
	});
});
