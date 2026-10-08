import { describe, expect, test } from "bun:test";

import {
	CHECK_NAME,
	cell,
	checkFor,
	commentFor,
	DESIGN_REVIEW_MARKER,
	interpretVerdict,
	MAX_ROWS,
	type Outcome,
} from "./outcome.ts";
import { context, finding, SHA, verdictDoc } from "./test-fixtures.ts";

function reviewed(findings = [finding()]): Outcome {
	return interpretVerdict(JSON.stringify(verdictDoc(findings)), SHA);
}

describe("names", () => {
	test("keeps the check name and the comment marker stable for warren-dbef", () => {
		expect(CHECK_NAME).toBe("design-review");
		expect(DESIGN_REVIEW_MARKER).toBe("<!-- design-review -->");
	});
});

describe("interpretVerdict", () => {
	test("fails closed when there is no verdict file", () => {
		expect(interpretVerdict(null, SHA)).toEqual({
			kind: "invalid",
			errors: ["the evaluator wrote no verdict file"],
		});
	});

	test("fails closed on a file that is not JSON", () => {
		const outcome = interpretVerdict("not json", SHA);
		expect(outcome.kind).toBe("invalid");
	});

	test("fails closed when the verdict reviewed another commit", () => {
		const outcome = interpretVerdict(JSON.stringify(verdictDoc()), "f".repeat(40));
		expect(outcome.kind).toBe("invalid");
		if (outcome.kind === "invalid") expect(outcome.errors[0]).toContain("headSha");
	});

	test("fails closed when the model's verdict field disagrees with its findings", () => {
		const doc = verdictDoc([finding({ severity: "blocker" })], { verdict: "pass" });
		expect(interpretVerdict(JSON.stringify(doc), SHA).kind).toBe("invalid");
	});

	test("reads a valid PASS and a valid FAIL with ranked findings", () => {
		const pass = reviewed();
		expect(pass.kind === "reviewed" && pass.decision.verdict).toBe("pass");
		const fail = reviewed([finding(), finding({ severity: "blocker", criterion: "phone-layout" })]);
		expect(fail.kind).toBe("reviewed");
		if (fail.kind === "reviewed") {
			expect(fail.decision.verdict).toBe("fail");
			expect(fail.verdict.findings[0]?.severity).toBe("blocker");
		}
	});
});

describe("checkFor", () => {
	const ctx = context();

	test("passes only a PASS verdict and a skip", () => {
		expect(checkFor(reviewed(), ctx)).toMatchObject({
			status: "completed",
			conclusion: "success",
			title: "PASS: 0 blockers, 0 majors, 1 minor",
		});
		expect(checkFor({ kind: "skipped", reason: "no-ui-changes" }, null)).toMatchObject({
			conclusion: "success",
			title: "Skipped: no src/ui changes",
		});
		expect(checkFor({ kind: "skipped", reason: "no-rendered-changes" }, null).title).toBe(
			"Skipped: no rendered src/ui changes",
		);
	});

	test("fails a FAIL verdict, an invalid verdict, and a failed ui-visual run", () => {
		const fail = reviewed([finding({ severity: "blocker" })]);
		expect(checkFor(fail, ctx)).toMatchObject({
			conclusion: "failure",
			title: expect.stringMatching(/^FAIL: 1 blocker/),
		});
		expect(checkFor({ kind: "invalid", errors: ["x"] }, ctx)).toMatchObject({
			conclusion: "failure",
		});
		expect(checkFor({ kind: "not-run" }, ctx)).toMatchObject({
			conclusion: "failure",
			title: "Not run: ui-visual failed",
		});
	});

	test("leaves the check open while waiting or reviewing", () => {
		expect(checkFor({ kind: "waiting" }, null).status).toBe("queued");
		expect(checkFor({ kind: "running" }, null).status).toBe("in_progress");
	});

	test("uses the comment, minus its marker, as the summary", () => {
		const check = checkFor(reviewed(), ctx);
		expect(check.summary.startsWith("\n### Design review: PASS")).toBe(true);
	});
});

describe("cell", () => {
	test("neutralizes markdown, HTML, mentions, and table breaks", () => {
		const out = cell("<img src=x> @octocat | ![a](http://x) `code`\nnext #12");
		expect(out).not.toContain("<");
		expect(out).not.toContain("@");
		expect(out).toContain("&#64;octocat");
		expect(out).toContain("\\|");
		expect(out).toContain("\\!\\[a\\]\\(http://x\\)");
		expect(out).toContain("\\`code\\`");
		expect(out).not.toContain("\n");
	});

	test("redacts credential-shaped strings", () => {
		const out = cell(`key sk-ant-api03-abcDEF_123 and ghs_${"a".repeat(36)}`);
		expect(out).not.toContain("sk-ant");
		expect(out).not.toContain("ghs_");
		expect(out).toContain("\\[redacted\\]");
	});
});

describe("commentFor", () => {
	test("starts with the marker and lists diff findings before pre-existing ones", () => {
		const outcome = reviewed([
			finding({ origin: "pre-existing", severity: "major", issue: "Old gutter." }),
			finding({ severity: "minor", issue: "New gap." }),
		]);
		const body = commentFor(outcome, context());
		expect(body.startsWith(`${DESIGN_REVIEW_MARKER}\n### Design review: PASS`)).toBe(true);
		expect(body.indexOf("New gap.")).toBeLessThan(body.indexOf("Old gutter."));
		expect(body).toContain("<details><summary>1 pre-existing finding (not counted)</summary>");
		expect(body).toContain("cost $1.23, 17 turns");
		expect(body).toContain("model `claude-opus-5-5`");
	});

	test("caps each table and says how many rows it hid", () => {
		const many = Array.from({ length: MAX_ROWS + 3 }, () => finding());
		const body = commentFor(reviewed(many), context());
		expect(body).toContain("3 more findings not shown");
	});

	test("explains an invalid verdict and how to re-run", () => {
		const body = commentFor(
			{ kind: "invalid", errors: ["findings[0].page: must be one of"] },
			context({ evaluator: "failure" }),
		);
		expect(body).toContain("### Design review: no valid verdict");
		expect(body).toContain("`failure`");
		expect(body).toContain("gh workflow run ui-design-review.yml -f run_id=99");
	});

	test("names the scope for every page and for none", () => {
		const all = commentFor({ kind: "not-run" }, context({ allPages: true, pages: ["a", "b"] }));
		expect(all).toContain("all 2 pages");
		expect(all).not.toContain("Evaluator:");
		const none = commentFor({ kind: "skipped", reason: "no-ui-changes" }, context({ pages: [] }));
		expect(none).toContain("pages: none");
	});
});
