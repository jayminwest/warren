import { describe, expect, test } from "bun:test";
import { hasAutoPlanRunFrontmatter } from "./auto-plan-run.ts";

describe("hasAutoPlanRunFrontmatter (warren-5f07)", () => {
	const wrap = (auto_plan_run: unknown) => ({
		renderedAgentJson: { frontmatter: { auto_plan_run } },
	});

	test("detects the boolean true", () => {
		expect(hasAutoPlanRunFrontmatter(wrap(true))).toBe(true);
	});

	test("coerces the string 'true' (cn --fm stringifies values)", () => {
		expect(hasAutoPlanRunFrontmatter(wrap("true"))).toBe(true);
		expect(hasAutoPlanRunFrontmatter(wrap(" TRUE "))).toBe(true);
	});

	test("treats the string 'false' as disabled", () => {
		expect(hasAutoPlanRunFrontmatter(wrap("false"))).toBe(false);
	});

	test("rejects other values and missing/malformed frontmatter", () => {
		expect(hasAutoPlanRunFrontmatter(wrap(false))).toBe(false);
		expect(hasAutoPlanRunFrontmatter(wrap(1))).toBe(false);
		expect(hasAutoPlanRunFrontmatter(wrap(undefined))).toBe(false);
		expect(hasAutoPlanRunFrontmatter({ renderedAgentJson: null })).toBe(false);
		expect(hasAutoPlanRunFrontmatter({ renderedAgentJson: { frontmatter: [] } })).toBe(false);
	});
});
