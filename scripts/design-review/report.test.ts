import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeGhApi } from "../ui-visual/fake-gh-api.ts";
import { DESIGN_REVIEW_MARKER } from "./outcome.ts";
import { type ReportInput, runReport, USAGE_FILE, VERDICT_FILE } from "./report.ts";
import { context, finding, SHA, verdictDoc } from "./test-fixtures.ts";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function verdictDir(verdict: unknown, usage: unknown = { costUsd: 0.5, turns: 12 }): string {
	const dir = mkdtempSync(join(tmpdir(), "design-review-report-"));
	temps.push(dir);
	if (verdict !== undefined) {
		const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
		writeFileSync(join(dir, VERDICT_FILE), text);
	}
	writeFileSync(join(dir, USAGE_FILE), JSON.stringify(usage));
	return dir;
}

function setup(
	overrides: Partial<ReportInput> = {},
	pull: unknown = { state: "open", head: { sha: SHA } },
) {
	const checks = new FakeGhApi();
	const comments = new FakeGhApi();
	comments.pulls.set(7, pull);
	const { usage: _usage, ...ctx } = context();
	const input: ReportInput = {
		repo: "o/r",
		mode: "review",
		pr: 7,
		headSha: SHA,
		skipReason: "",
		ctx,
		verdictDir: null,
		...overrides,
	};
	return { checks, comments, input, deps: { checks, comments, log: () => {} } };
}

function body(api: FakeGhApi): string {
	return api.comments.get(7)?.[0]?.body ?? "";
}

describe("runReport", () => {
	test("passes the check and posts the sticky comment for a PASS verdict", async () => {
		const { checks, comments, deps, input } = setup({
			verdictDir: verdictDir(verdictDoc([finding()])),
		});
		expect(await runReport(deps, input)).toBe("success");
		expect(checks.checkRuns[0]).toMatchObject({
			name: "design-review",
			head_sha: SHA,
			conclusion: "success",
		});
		expect(comments.checkRuns).toEqual([]);
		expect(body(comments).startsWith(DESIGN_REVIEW_MARKER)).toBe(true);
		expect(body(comments)).toContain("cost $0.50, 12 turns");
	});

	test("fails the check on a FAIL verdict", async () => {
		const doc = verdictDoc([finding({ severity: "blocker" })]);
		const { checks, deps, input } = setup({ verdictDir: verdictDir(doc) });
		expect(await runReport(deps, input)).toBe("failure");
		expect(checks.checkRuns[0]?.output?.title).toMatch(/^FAIL: 1 blocker/);
	});

	test("fails closed, with an explanation, when the evaluator left no valid verdict", async () => {
		for (const dir of [null, verdictDir(undefined), verdictDir("{}")]) {
			const { checks, comments, deps, input } = setup({ verdictDir: dir });
			expect(await runReport(deps, input)).toBe("failure");
			expect(checks.checkRuns[0]?.output?.title).toBe("No valid verdict (fails closed)");
			expect(body(comments)).toContain("no valid verdict");
		}
	});

	test("fails closed when the prepare job never finished", async () => {
		const { deps, input } = setup({ mode: "" });
		expect(await runReport(deps, input)).toBe("failure");
	});

	test("passes a skip and only corrects an existing comment", async () => {
		const { checks, comments, deps, input } = setup({ mode: "skip", skipReason: "no-ui-changes" });
		expect(await runReport(deps, input)).toBe("success");
		expect(checks.checkRuns[0]?.output?.title).toBe("Skipped: no src/ui changes");
		expect(comments.comments.get(7)).toBeUndefined();
		comments.addComment(7, `${DESIGN_REVIEW_MARKER}\nold`);
		await runReport(deps, input);
		expect(body(comments)).toContain("skipped: no src/ui changes");
	});

	test("fails a not-run without posting a fresh comment", async () => {
		const { comments, deps, input } = setup({ mode: "not-run" });
		expect(await runReport(deps, input)).toBe("failure");
		expect(comments.comments.get(7)).toBeUndefined();
	});

	test("sets the check but leaves the comment once the PR moved on", async () => {
		const moved = { state: "open", head: { sha: "f".repeat(40) } };
		const { checks, comments, deps, input } = setup(
			{ verdictDir: verdictDir(verdictDoc()) },
			moved,
		);
		expect(await runReport(deps, input)).toBe("success");
		expect(checks.checkRuns).toHaveLength(1);
		expect(comments.comments.get(7)).toBeUndefined();
	});

	test("comments on a merged PR only for a manual allow-closed re-run", async () => {
		const merged = { state: "closed", head: { sha: SHA } };
		const plain = setup({ verdictDir: verdictDir(verdictDoc()) }, merged);
		await runReport(plain.deps, plain.input);
		expect(plain.comments.comments.get(7)).toBeUndefined();
		const manual = setup({ verdictDir: verdictDir(verdictDoc()), allowClosed: true }, merged);
		await runReport(manual.deps, manual.input);
		expect(body(manual.comments)).toContain("### Design review: PASS");
	});
});
