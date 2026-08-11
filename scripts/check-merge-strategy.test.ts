import { describe, expect, test } from "bun:test";
import { evaluate, GUARDED_PATHS, REQUIRED_DRIVER } from "./check-merge-strategy.ts";

const PATH = ".seeds/issues.jsonl";

/** A resolver that answers with a fixed attribute for every path. */
const always =
	(attr: string) =>
	(_path: string): string =>
		attr;

describe("check-merge-strategy evaluate", () => {
	test("passes when every guarded path resolves to the driver", () => {
		expect(evaluate(GUARDED_PATHS, always(REQUIRED_DRIVER))).toEqual([]);
	});

	test("fails when a path resolves to union, the sd doctor --fix regression", () => {
		const failures = evaluate([PATH], always("union"));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain(PATH);
		expect(failures[0]).toContain("merge=union");
		// The message must name the cause, because the appended line looks
		// like the tool tidying up after itself.
		expect(failures[0]).toContain("sd doctor --fix");
		expect(failures[0]).toContain("seeds-6e2d");
	});

	test("fails when a path resolves to any other unexpected strategy", () => {
		const failures = evaluate([PATH], always("ours"));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("resolves to merge=ours");
		expect(failures[0]).toContain(`expected merge=${REQUIRED_DRIVER}`);
	});

	test("reports one failure per offending path and none for the safe ones", () => {
		const failures = evaluate(GUARDED_PATHS, (path) => (path === PATH ? "union" : REQUIRED_DRIVER));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain(PATH);
	});

	test("surfaces a resolver error as a failure rather than throwing", () => {
		const failures = evaluate([PATH], () => {
			throw new Error("git check-attr failed");
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("git check-attr failed");
	});

	test("guards every id-keyed state file whose rows are rewritten in place", () => {
		// A path dropped from this list silently loses its protection, so the
		// list itself is asserted.
		expect(GUARDED_PATHS).toContain(".seeds/issues.jsonl");
		expect(GUARDED_PATHS).toContain(".seeds/plans.jsonl");
		expect(GUARDED_PATHS).toContain(".seeds/templates.jsonl");
	});
});
