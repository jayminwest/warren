import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "../forge/github/test-helpers.ts";
import {
	type CheckRun,
	classifyCheckRuns,
	extractJobId,
	fetchCheckRuns,
	fetchJobLogTail,
} from "./check-runs.ts";

function checkRun(over: Partial<CheckRun>): CheckRun {
	return {
		id: 1,
		name: "ci",
		status: "completed",
		conclusion: "success",
		detailsUrl: null,
		...over,
	};
}

describe("classifyCheckRuns", () => {
	test("returns no_checks for an empty list", () => {
		expect(classifyCheckRuns([]).verdict).toBe("no_checks");
	});

	test("returns pending when any check-run is not completed", () => {
		const result = classifyCheckRuns([
			checkRun({ status: "completed", conclusion: "success" }),
			checkRun({ id: 2, status: "in_progress", conclusion: null }),
		]);
		expect(result.verdict).toBe("pending");
		expect(result.failures).toEqual([]);
	});

	test("returns passing when all completed with success-ish conclusions", () => {
		const result = classifyCheckRuns([
			checkRun({ conclusion: "success" }),
			checkRun({ id: 2, conclusion: "neutral" }),
			checkRun({ id: 3, conclusion: "skipped" }),
		]);
		expect(result.verdict).toBe("passing");
	});

	test("returns failing with the failing check-runs when any failure-ish conclusion present", () => {
		const failing = checkRun({ id: 2, name: "test", conclusion: "failure" });
		const result = classifyCheckRuns([checkRun({ conclusion: "success" }), failing]);
		expect(result.verdict).toBe("failing");
		expect(result.failures).toEqual([failing]);
	});

	test("treats timed_out / action_required / cancelled / startup_failure as failures", () => {
		for (const conclusion of ["timed_out", "action_required", "cancelled", "startup_failure"]) {
			const result = classifyCheckRuns([checkRun({ conclusion })]);
			expect(result.verdict).toBe("failing");
		}
	});
});

describe("fetchCheckRuns", () => {
	test("returns missing_token when token is empty", async () => {
		const result = await fetchCheckRuns({ owner: "o", repo: "r", ref: "abc", token: "" });
		expect(result.kind).toBe("missing_token");
	});

	test("parses check-runs from a 200 response", async () => {
		const fetchImpl = (async () =>
			jsonResponse(200, {
				check_runs: [
					{ id: 7, name: "lint", status: "completed", conclusion: "failure", details_url: "u" },
					{ id: 8, name: "test", status: "completed", conclusion: "success" },
				],
			})) as unknown as typeof fetch;
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch: fetchImpl,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.checkRuns).toHaveLength(2);
			expect(result.checkRuns[0]).toEqual({
				id: 7,
				name: "lint",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "u",
			});
		}
	});

	test("returns http_error on non-200", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 404 })) as unknown as typeof fetch;
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch: fetchImpl,
		});
		expect(result.kind).toBe("http_error");
		if (result.kind === "http_error") expect(result.status).toBe(404);
	});

	test("sends the canonical transport headers (content-type included, warren-e5d3)", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { check_runs: [] })]);
		const result = await fetchCheckRuns({ owner: "o", repo: "r", ref: "abc", token: "t", fetch });
		expect(result.kind).toBe("ok");
		const headers = calls[0]?.headers ?? {};
		expect(headers.authorization).toBe("Bearer t");
		expect(headers.accept).toBe("application/vnd.github+json");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["user-agent"]).toBe("warren-ci-fixer");
		expect(headers["x-github-api-version"]).toBe("2022-11-28");
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100",
		);
	});

	test("retries a transient 429 then succeeds (transport core policy, warren-e5d3)", async () => {
		const { fetch, calls } = recordingFetch([
			new Response("slow down", { status: 429 }),
			jsonResponse(200, { check_runs: [] }),
		]);
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch,
			retry: { sleep: async () => {} },
		});
		expect(result.kind).toBe("ok");
		expect(calls).toHaveLength(2);
	});

	test("does not retry a fatal 4xx", async () => {
		const { fetch, calls } = recordingFetch([new Response("gone", { status: 404 })]);
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch,
			retry: { sleep: async () => {} },
		});
		expect(result.kind).toBe("http_error");
		expect(calls).toHaveLength(1);
	});

	test("returns http_error with status 0 when fetch throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch: fetchImpl,
			retry: { sleep: async () => {} },
		});
		expect(result.kind).toBe("http_error");
		if (result.kind === "http_error") expect(result.status).toBe(0);
	});

	test("drops malformed check-run entries without an id", async () => {
		const fetchImpl = (async () =>
			jsonResponse(200, {
				check_runs: [{ name: "no-id" }, { id: 9, name: "ok", status: "completed" }],
			})) as unknown as typeof fetch;
		const result = await fetchCheckRuns({
			owner: "o",
			repo: "r",
			ref: "abc",
			token: "t",
			fetch: fetchImpl,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.checkRuns).toHaveLength(1);
			expect(result.checkRuns[0]?.id).toBe(9);
		}
	});
});

describe("extractJobId", () => {
	test("parses the job id from an Actions details_url", () => {
		expect(extractJobId("https://github.com/o/r/actions/runs/123/job/456", 9)).toBe(456);
	});

	test("falls back to the check-run id when the url has no job segment", () => {
		expect(extractJobId("https://example-ci.test/build/42", 9)).toBe(9);
		expect(extractJobId(null, 9)).toBe(9);
	});
});

describe("fetchJobLogTail", () => {
	const base = { owner: "o", repo: "r", jobId: 456 };

	test("returns null when the token is empty or tailLines <= 0", async () => {
		expect(await fetchJobLogTail({ ...base, token: "" }, 10)).toBeNull();
		expect(await fetchJobLogTail({ ...base, token: "t" }, 0)).toBeNull();
	});

	test("returns the last N lines of the resolved log", async () => {
		const fetchImpl = (async () =>
			new Response("l1\nl2\nl3\nl4\n", { status: 200 })) as unknown as typeof fetch;
		const tail = await fetchJobLogTail({ ...base, token: "t", fetch: fetchImpl }, 2);
		expect(tail).toBe("l3\nl4");
	});

	test("returns the whole (trimmed) log when it has fewer lines than the tail", async () => {
		const fetchImpl = (async () =>
			new Response("only\n", { status: 200 })) as unknown as typeof fetch;
		expect(await fetchJobLogTail({ ...base, token: "t", fetch: fetchImpl }, 200)).toBe("only");
	});

	test("returns null on a non-2xx (e.g. 410 expired logs)", async () => {
		const fetchImpl = (async () =>
			new Response("gone", { status: 410 })) as unknown as typeof fetch;
		expect(await fetchJobLogTail({ ...base, token: "t", fetch: fetchImpl }, 10)).toBeNull();
	});

	test("returns null when the fetch throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(
			await fetchJobLogTail(
				{ ...base, token: "t", fetch: fetchImpl, retry: { sleep: async () => {} } },
				10,
			),
		).toBeNull();
	});

	test("retries a transient 5xx then returns the log tail", async () => {
		const { fetch, calls } = recordingFetch([
			new Response("oops", { status: 502 }),
			new Response("a\nb\nc\n", { status: 200 }),
		]);
		const tail = await fetchJobLogTail(
			{ ...base, token: "t", fetch, retry: { sleep: async () => {} } },
			2,
		);
		expect(tail).toBe("b\nc");
		expect(calls).toHaveLength(2);
	});

	test("returns null for an empty log body", async () => {
		const fetchImpl = (async () =>
			new Response("  \n ", { status: 200 })) as unknown as typeof fetch;
		expect(await fetchJobLogTail({ ...base, token: "t", fetch: fetchImpl }, 10)).toBeNull();
	});
});
