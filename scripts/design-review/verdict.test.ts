import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	CRITERIA,
	caseNames,
	checkCiMeta,
	decide,
	type Finding,
	parseVerdict,
	rankFindings,
	runCli,
	VERDICT_SCHEMA,
} from "./verdict.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		criterion: "hierarchy",
		severity: "minor",
		origin: "diff",
		page: "runs",
		viewport: "desktop",
		theme: "dark",
		evidence: "runs.desktop.dark.png",
		issue: "Two section labels use different tracking.",
		fix: "Use the shared section-label class on both.",
		...overrides,
	};
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: VERDICT_SCHEMA,
		rubric: 1,
		headSha: SHA,
		verdict: "pass",
		pagesInScope: ["runs"],
		casesReviewed: caseNames("runs"),
		findings: [],
		summary: "Runs page reviewed in both viewports and themes.",
		...overrides,
	};
}

function errorsOf(raw: unknown): readonly string[] {
	const result = parseVerdict(raw);
	return result.ok ? [] : result.errors;
}

describe("decide", () => {
	test("passes with no blockers and at most two majors", () => {
		const majors = [finding({ severity: "major" }), finding({ severity: "major" })];
		expect(decide([...majors, finding(), finding(), finding()]).verdict).toBe("pass");
	});

	test("fails on one blocker or a third major", () => {
		expect(decide([finding({ severity: "blocker" })]).verdict).toBe("fail");
		const majors = [1, 2, 3].map(() => finding({ severity: "major" }));
		expect(decide(majors)).toEqual({
			verdict: "fail",
			counts: { blocker: 0, major: 3, minor: 0 },
		});
	});

	test("ignores pre-existing findings", () => {
		const old = finding({ severity: "blocker", origin: "pre-existing" });
		expect(decide([old]).verdict).toBe("pass");
		expect(decide([old]).counts.blocker).toBe(0);
	});
});

describe("rankFindings", () => {
	test("orders by severity, then diff before pre-existing, then input order", () => {
		const a = finding({ severity: "minor", issue: "a" });
		const b = finding({ severity: "blocker", origin: "pre-existing", issue: "b" });
		const c = finding({ severity: "blocker", issue: "c" });
		const d = finding({ severity: "minor", issue: "d" });
		expect(rankFindings([a, b, c, d]).map((f) => f.issue)).toEqual(["c", "b", "a", "d"]);
	});
});

describe("parseVerdict", () => {
	test("accepts a well-formed passing verdict", () => {
		const result = parseVerdict(doc({ findings: [finding()] }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.decision.counts.minor).toBe(1);
	});

	test("accepts shell findings and both-viewport findings", () => {
		const f = finding({ page: "shell", viewport: "both", theme: "both" });
		expect(errorsOf(doc({ findings: [f] }))).toEqual([]);
	});

	test("rejects a non-object document", () => {
		expect(errorsOf([])).toEqual(["verdict: must be a JSON object"]);
	});

	test("rejects unknown fields, bad enums, and multi-line text", () => {
		const bad = { ...finding(), severity: "critical", page: "nowhere", extra: 1, fix: "a\nb" };
		const errors = errorsOf(doc({ note: "x", findings: [bad] }));
		expect(errors).toContain('verdict: unknown field "note"');
		expect(errors).toContain('findings[0]: unknown field "extra"');
		expect(errors.some((e) => e.startsWith("findings[0].severity:"))).toBe(true);
		expect(errors.some((e) => e.startsWith("findings[0].page:"))).toBe(true);
		expect(errors).toContain("findings[0].fix: must be one line");
	});

	test("rejects a wrong schema, rubric, sha, and empty scope", () => {
		const errors = errorsOf(
			doc({ schema: "v0", rubric: 2, headSha: "HEAD", pagesInScope: [], casesReviewed: [] }),
		);
		expect(errors).toHaveLength(4);
	});

	test("rejects over-long lines and a missing findings array", () => {
		const errors = errorsOf(doc({ findings: undefined, summary: "x".repeat(601) }));
		expect(errors).toContain("findings: must be an array");
		expect(errors).toContain("summary: longer than 600 characters");
	});

	test("rejects a declared verdict the findings contradict", () => {
		const errors = errorsOf(doc({ findings: [finding({ severity: "blocker" })] }));
		expect(errors).toEqual(['verdict: says "pass" but the findings decide "fail"']);
	});

	test("requires every in-scope case or an evidence-complete finding", () => {
		const partial = caseNames("runs").slice(0, 3);
		expect(errorsOf(doc({ casesReviewed: partial }))).toEqual([
			"casesReviewed: missing runs.phone.dark with no evidence-complete finding",
		]);
		const flagged = finding({
			criterion: "evidence-complete",
			severity: "blocker",
			viewport: "phone",
		});
		const result = parseVerdict(
			doc({ casesReviewed: partial, verdict: "fail", findings: [flagged] }),
		);
		expect(result.ok).toBe(true);
	});
});

describe("checkCiMeta", () => {
	const verdict = parseVerdict(doc());
	if (!verdict.ok) throw new Error("fixture verdict must parse");

	test("accepts a matching head sha", () => {
		expect(checkCiMeta(verdict.value, { headSha: SHA, outcome: "success" })).toEqual([]);
	});

	test("rejects a stale artifact and a non-object", () => {
		expect(checkCiMeta(verdict.value, { headSha: "abc1234" })).toHaveLength(1);
		expect(checkCiMeta(verdict.value, null)).toEqual(["ci-meta: must be a JSON object"]);
	});
});

describe("runCli", () => {
	const files: Record<string, string> = {
		"pass.json": JSON.stringify(doc()),
		"fail.json": JSON.stringify(
			doc({ verdict: "fail", findings: [finding({ severity: "blocker" })] }),
		),
		"meta.json": JSON.stringify({ headSha: SHA }),
		"stale.json": JSON.stringify({ headSha: "abc1234" }),
		"broken.json": "{",
	};
	const read = (p: string): string => {
		const body = files[p];
		if (body === undefined) throw new Error(`ENOENT: ${p}`);
		return body;
	};

	test("exits 0 on a valid pass and 1 on a valid fail", () => {
		expect(runCli(["pass.json", "--ci-meta", "meta.json"], read).code).toBe(0);
		const fail = runCli(["fail.json"], read);
		expect(fail.code).toBe(1);
		expect(fail.report.counts).toEqual({ blocker: 1, major: 0, minor: 0 });
	});

	test("exits 2 on bad usage, unreadable JSON, and a stale artifact", () => {
		expect(runCli([], read).code).toBe(2);
		expect(runCli(["pass.json", "--ci-meta"], read).code).toBe(2);
		expect(runCli(["missing.json"], read).report.errors).toEqual(["ENOENT: missing.json"]);
		expect(runCli(["broken.json"], read).code).toBe(2);
		expect(runCli(["pass.json", "--ci-meta", "stale.json"], read).code).toBe(2);
		expect(runCli(["fail.json", "--ci-meta", "missing.json"], read).code).toBe(2);
	});
});

describe("rubric drift", () => {
	const record = readFileSync(join(REPO_ROOT, "docs/design/ui-design-review.md"), "utf8");
	const skill = readFileSync(join(REPO_ROOT, ".claude/skills/ui-design-review/SKILL.md"), "utf8");

	test("gives every criterion id its own section in the design record", () => {
		const missing = CRITERIA.filter((id) => !record.includes(`### \`${id}\``));
		expect(missing).toEqual([]);
	});

	test("names the schema and the validator in the record and the skill", () => {
		for (const text of [record, skill]) {
			expect(text).toContain(VERDICT_SCHEMA);
			expect(text).toContain("scripts/design-review/verdict.ts");
		}
	});
});
