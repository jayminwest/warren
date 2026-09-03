import { afterEach, describe, expect, test } from "bun:test";
// Relative imports, not the `@/` alias — this file runs under the
// repo-root `bun test`, which resolves no `@/` (see format.test.ts).
import {
	fetchJudgeVerdicts,
	type JudgeStoreRow,
	summarizeJudgeVerdicts,
} from "./judge-verdicts.ts";

/** Minimal verdict row builder. */
function row(overrides: Partial<JudgeStoreRow> = {}): JudgeStoreRow {
	return {
		id: 1,
		kind: "verdict",
		runId: "run-1",
		rubricVersion: "sha256:abc",
		judgeModelId: "m",
		verdict: {
			runId: "run-1",
			assignments: [{ class: "clean", confidence: "high" }],
			provenance: { provider: "p", model: "m", rubricVersion: "v", judgedAt: "t", costUsd: 0 },
		},
		reason: null,
		detail: null,
		...overrides,
	};
}

const SIGNAL = new AbortController().signal;
const realFetch = globalThis.fetch;

function mockFetch(res: Response): void {
	globalThis.fetch = async () => res;
}

function ndjsonResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fetchJudgeVerdicts", () => {
	test("parses an NDJSON page of verdict rows", async () => {
		mockFetch(ndjsonResponse(`${JSON.stringify(row())}\n${JSON.stringify(row({ id: 2 }))}\n`));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: true, rows: [row(), row({ id: 2 })] });
	});

	test("classifies an empty NDJSON page as available with zero rows", async () => {
		mockFetch(ndjsonResponse(""));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: true, rows: [] });
	});

	test("classifies an HTML body as misconfigured, not a healthy judge", async () => {
		mockFetch(
			new Response("<!doctype html><html><body>SPA fallback</body></html>\n", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "misconfigured" });
	});

	test("classifies an HTML body with no content-type as misconfigured", async () => {
		mockFetch(new Response("<html>index</html>", { status: 200 }));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "misconfigured" });
	});

	test("classifies the proxy's 501 as absent", async () => {
		mockFetch(new Response("{}", { status: 501, headers: { "content-type": "application/json" } }));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "absent" });
	});

	test("classifies 401 as unauthorized", async () => {
		mockFetch(new Response("{}", { status: 401 }));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "unauthorized" });
	});

	test("classifies a 502 from the proxy as a transport error", async () => {
		mockFetch(new Response("{}", { status: 502 }));
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "error" });
	});

	test("classifies a network throw as a transport error", async () => {
		globalThis.fetch = async () => {
			throw new TypeError("fetch failed");
		};
		const state = await fetchJudgeVerdicts(SIGNAL);
		expect(state).toEqual({ available: false, reason: "error" });
	});

	test("targets the same-origin warren proxy path", async () => {
		let seenUrl = "";
		globalThis.fetch = async (input: unknown) => {
			seenUrl = String(input);
			return ndjsonResponse("");
		};
		await fetchJudgeVerdicts(SIGNAL);
		expect(seenUrl).toStartWith("/extensions/judge/verdicts.jsonl?limit=");
	});

	test("requests the newest page with order=desc (warren-f282)", async () => {
		let seenUrl = "";
		globalThis.fetch = async (input: unknown) => {
			seenUrl = String(input);
			return ndjsonResponse("");
		};
		await fetchJudgeVerdicts(SIGNAL);
		const url = new URL(seenUrl, "http://x.test");
		expect(url.searchParams.get("order")).toBe("desc");
		expect(url.searchParams.get("limit")).toBe("500");
	});
});

describe("summarizeJudgeVerdicts", () => {
	test("returns null pass rate and empty tallies for zero rows", () => {
		const s = summarizeJudgeVerdicts([]);
		expect(s).toEqual({
			pass: 0,
			fail: 0,
			unjudged: 0,
			passRate: null,
			judgedRate: null,
			failingClasses: [],
			rubricVersions: [],
		});
	});

	test("judgedRate counts unjudged markers in the denominator (warren-f282)", () => {
		const failing = row({
			id: 2,
			verdict: {
				runId: "run-2",
				assignments: [{ class: "tests_failing", confidence: "high" }],
				provenance: { provider: "p", model: "m", rubricVersion: "v", judgedAt: "t", costUsd: 0 },
			},
		});
		const s = summarizeJudgeVerdicts([
			row(),
			failing,
			row({ id: 3, kind: "unjudged", verdict: null, reason: "malformed_verdict" }),
			row({ id: 4, kind: "unjudged", verdict: null, reason: "malformed_verdict" }),
		]);
		expect(s.passRate).toBe(0.5); // 1 pass of 2 judged
		expect(s.judgedRate).toBe(0.5); // but only 2 of 4 rows were judged
	});

	test("counts clean verdicts as pass", () => {
		const s = summarizeJudgeVerdicts([row(), row({ id: 2 })]);
		expect(s.pass).toBe(2);
		expect(s.fail).toBe(0);
		expect(s.passRate).toBe(1);
	});

	test("counts non-clean classes and sorts them worst first", () => {
		const failing = row({
			id: 2,
			verdict: {
				runId: "run-2",
				assignments: [
					{ class: "tests_failing", confidence: "high" },
					{ class: "tests_failing", confidence: "low" },
					{ class: "scope_creep", confidence: "medium" },
				],
				provenance: { provider: "p", model: "m", rubricVersion: "v", judgedAt: "t", costUsd: 0 },
			},
		});
		const s = summarizeJudgeVerdicts([row(), failing]);
		expect(s.pass).toBe(1);
		expect(s.fail).toBe(1);
		expect(s.passRate).toBe(0.5);
		expect(s.failingClasses).toEqual([
			{ name: "tests_failing", count: 2 },
			{ name: "scope_creep", count: 1 },
		]);
	});

	test("counts unjudged marker rows without a pass/fail verdict", () => {
		const s = summarizeJudgeVerdicts([
			row({ id: 3, kind: "unjudged", verdict: null, reason: "judge_error" }),
		]);
		expect(s.unjudged).toBe(1);
		expect(s.pass).toBe(0);
		expect(s.fail).toBe(0);
		expect(s.passRate).toBe(null);
	});

	test("collects distinct rubric versions", () => {
		const s = summarizeJudgeVerdicts([row(), row({ id: 2, rubricVersion: "sha256:def" })]);
		expect(s.rubricVersions.sort()).toEqual(["sha256:abc", "sha256:def"]);
	});
});
