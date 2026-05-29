import { describe, expect, test } from "bun:test";
import { type CheckRun, classifyCheckRuns, fetchCheckRuns } from "./check-runs.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
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
			jsonResponse({
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
		});
		expect(result.kind).toBe("http_error");
		if (result.kind === "http_error") expect(result.status).toBe(0);
	});

	test("drops malformed check-run entries without an id", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
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
