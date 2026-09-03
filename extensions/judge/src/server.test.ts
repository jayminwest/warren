/**
 * Plan pl-17ca step 8 (warren-265d): the export surface.
 *
 * Pins the bearer gate (401 from birth, no public projection), the
 * `?since=<id>` paging contract over the store's rowid sequence, and the
 * agreement-summary endpoint over the stored calibration metric.
 */

import { describe, expect, test } from "bun:test";
import { CalibrationMetricStore, computeAgreement } from "./calibration.ts";
import { createFetchHandler } from "./server.ts";
import { VerdictStore } from "./verdict-store.ts";
import type { JudgeVerdict } from "./wire.ts";

const TOKEN = "export-token-123";
const RUBRIC = "sha256:test-rubric";

function verdict(runId: string, model: string, judgedAt: string): JudgeVerdict {
	return {
		runId,
		assignments: [
			{
				class: "spin_loop",
				confidence: "medium",
				evidence: [{ fromSeq: 3, toSeq: 9 }],
			},
		],
		provenance: {
			provider: "anthropic",
			model,
			rubricVersion: RUBRIC,
			judgedAt,
			costUsd: 0.01,
		},
	};
}

function makeDeps(dbPath: string) {
	const verdicts = new VerdictStore(dbPath);
	const metrics = new CalibrationMetricStore(dbPath);
	const handler = createFetchHandler({
		verdicts,
		metrics,
		exportToken: TOKEN,
		extensionName: "judge",
		extensionVersion: "0.0.0",
	});
	return { verdicts, metrics, handler };
}

function authed(path: string, token: string | null = TOKEN): Request {
	const headers = new Headers();
	if (token !== null) headers.set("authorization", `Bearer ${token}`);
	return new Request(`http://export.test${path}`, { headers });
}

describe("export surface auth", () => {
	test("rejects a missing token with 401 and serves no rows", async () => {
		const { handler } = makeDeps(":memory:");
		const res = handler(authed("/verdicts.jsonl", null));
		expect(res.status).toBe(401);
	});

	test("rejects a wrong token with 401", async () => {
		const { handler } = makeDeps(":memory:");
		const res = handler(authed("/verdicts.jsonl", "wrong"));
		expect(res.status).toBe(401);
	});

	test("rejects a non-bearer scheme with 401", async () => {
		const { handler } = makeDeps(":memory:");
		const req = new Request("http://export.test/verdicts.jsonl", {
			headers: { authorization: `Basic ${TOKEN}` },
		});
		expect(handler(req).status).toBe(401);
	});

	test("gates /agreement behind the same token", async () => {
		const { handler } = makeDeps(":memory:");
		expect(handler(authed("/agreement", null)).status).toBe(401);
	});

	test("serves /healthz unauthenticated with no data payload", async () => {
		const { handler } = makeDeps(":memory:");
		const res = handler(authed("/healthz", null));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body).not.toHaveProperty("verdictRows");
	});

	test("rejects non-GET methods with 405", async () => {
		const { handler } = makeDeps(":memory:");
		const req = new Request("http://export.test/verdicts.jsonl", { method: "POST" });
		expect(handler(req).status).toBe(405);
	});
});

describe("GET /verdicts.jsonl", () => {
	test("pages rows after ?since in id order and exports unjudged markers", async () => {
		const { verdicts, handler } = makeDeps(":memory:");
		const first = verdicts.recordVerdict(verdict("r-1", "cheap-model", "2026-08-15T00:00:00Z"));
		verdicts.recordUnjudged({
			runId: "r-2",
			rubricVersion: RUBRIC,
			judgeModelId: "cheap-model",
			reason: "budget_exceeded",
			detail: "accrued cost $0.2500 reached per-judgment cap",
		});
		const third = verdicts.recordVerdict(verdict("r-3", "cheap-model", "2026-08-15T00:01:00Z"));
		expect(first).not.toBeNull();
		expect(third).not.toBeNull();

		const res = handler(authed(`/verdicts.jsonl?since=${String(first)}`));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/x-ndjson");
		expect(res.headers.get("X-Verdicts-Max-Id")).toBe(String(third));
		const rows = (await res.text())
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { id: number; kind: string; runId: string; detail: string | null },
			);
		expect(rows.map((r) => r.id)).toEqual([2, 3]);
		expect(rows[0]?.kind).toBe("unjudged");
		expect(rows[0]?.runId).toBe("r-2");
		expect(rows[0]?.detail).toBe("accrued cost $0.2500 reached per-judgment cap");
		expect(rows[1]?.detail).toBeNull();
		expect(rows[1]?.kind).toBe("verdict");
	});

	test("empty page still carries the max-id checkpoint header", async () => {
		const { verdicts, handler } = makeDeps(":memory:");
		verdicts.recordVerdict(verdict("r-1", "cheap-model", "2026-08-15T00:00:00Z"));
		const res = handler(authed("/verdicts.jsonl?since=999"));
		expect(res.headers.get("X-Verdicts-Max-Id")).toBe("1");
		expect(await res.text()).toBe("");
	});

	test("serves the newest page with ?order=desc (warren-f282)", async () => {
		const { verdicts, handler } = makeDeps(":memory:");
		for (let i = 0; i < 5; i += 1) {
			verdicts.recordVerdict(verdict(`r-${i}`, "cheap-model", "2026-08-15T00:00:00Z"));
		}
		const res = handler(authed("/verdicts.jsonl?limit=3&order=desc"));
		expect(res.status).toBe(200);
		const rows = (await res.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: number });
		// The newest 3 ids, descending — not the oldest 3 the asc default serves.
		expect(rows.map((r) => r.id)).toEqual([5, 4, 3]);
	});

	test("rejects an order other than asc|desc", async () => {
		const { handler } = makeDeps(":memory:");
		const res = handler(authed("/verdicts.jsonl?order=newest"));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("order");
	});

	test("honors ?limit and rejects malformed paging params", async () => {
		const { verdicts, handler } = makeDeps(":memory:");
		for (let i = 0; i < 3; i += 1) {
			verdicts.recordVerdict(verdict(`r-${i}`, "cheap-model", "2026-08-15T00:00:00Z"));
		}
		const page = handler(authed("/verdicts.jsonl?limit=2"));
		expect((await page.text()).trim().split("\n")).toHaveLength(2);
		expect(handler(authed("/verdicts.jsonl?since=-1")).status).toBe(400);
		expect(handler(authed("/verdicts.jsonl?since=1.5")).status).toBe(400);
		expect(handler(authed("/verdicts.jsonl?limit=0")).status).toBe(400);
	});
});

describe("GET /agreement", () => {
	test("reports the empty list when calibration is disabled", async () => {
		const verdicts = new VerdictStore(":memory:");
		const handler = createFetchHandler({
			verdicts,
			metrics: null,
			exportToken: TOKEN,
			extensionName: "judge",
			extensionVersion: "0.0.0",
		});
		const res = handler(authed("/agreement"));
		expect(res.status).toBe(200);
		expect((await res.json()) as { reports: unknown[] }).toEqual({ reports: [] });
	});

	test("returns the latest stored report per rubric version", async () => {
		const { verdicts, metrics, handler } = makeDeps(":memory:");
		verdicts.recordVerdict(verdict("r-1", "cheap-model", "2026-08-15T00:00:00Z"));
		verdicts.recordVerdict(verdict("r-1", "strong-model", "2026-08-15T01:00:00Z"));
		const pairs = verdicts.calibrationPairs(RUBRIC, "cheap-model", "strong-model");
		const report = computeAgreement(pairs, {
			rubricVersion: RUBRIC,
			cheapModelId: "cheap-model",
			strongModelId: "strong-model",
		});
		metrics.record(report);

		const res = handler(authed("/agreement"));
		const body = (await res.json()) as { reports: Array<{ rubricVersion: string }> };
		expect(body.reports).toHaveLength(1);
		expect(body.reports[0]?.rubricVersion).toBe(RUBRIC);
		expect(body.reports[0]).toMatchObject({ sampledPairs: 1, overallRate: 1 });
	});

	test("serves one rubric version's latest plus history, 404 on unknown", async () => {
		const { verdicts, metrics, handler } = makeDeps(":memory:");
		verdicts.recordVerdict(verdict("r-1", "cheap-model", "2026-08-15T00:00:00Z"));
		verdicts.recordVerdict(verdict("r-1", "strong-model", "2026-08-15T01:00:00Z"));
		const pairs = verdicts.calibrationPairs(RUBRIC, "cheap-model", "strong-model");
		const identity = {
			rubricVersion: RUBRIC,
			cheapModelId: "cheap-model",
			strongModelId: "strong-model",
		};
		metrics.record(computeAgreement(pairs, identity));
		metrics.record(computeAgreement(pairs, identity));

		const res = handler(authed(`/agreement?rubricVersion=${RUBRIC}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { latest: unknown; history: unknown[] };
		expect(body.latest).not.toBeNull();
		expect(body.history).toHaveLength(2);

		const missing = handler(authed("/agreement?rubricVersion=sha256:nope"));
		expect(missing.status).toBe(404);
	});
});
