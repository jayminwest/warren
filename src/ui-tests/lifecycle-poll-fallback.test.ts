/**
 * Structural UI test for the warren-f566 polling posture (GH #847).
 *
 * The warren UI package ships without a React test harness (no jsdom, no
 * @testing-library, mx-a86ce6), so the invariant is pinned at the source
 * level the way `walk-inventory.test.ts` pins the walk page: read the
 * pages and assert what a regression would break.
 *
 * The invariant: after warren-f566 the global lifecycle stream drives
 * invalidation and every list surface keeps ONLY a slow fallback poll for
 * the gaps (public mode, where the operator-gated stream refuses, and any
 * notification dropped across a reconnect). A 5s timer coming back on any
 * of these surfaces is the regression, and it is worst on the plan-runs
 * row, where the poll is per row rather than per page.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_PAGES = join(import.meta.dir, "..", "ui", "src", "pages");
const read = (file: string): string => readFileSync(join(UI_PAGES, file), "utf8");

const SURFACES = [
	{ file: "runs.tsx", what: "the runs list" },
	{ file: "plan-runs.tsx", what: "the plan-runs list" },
	{ file: "plan-runs/walk-row.tsx", what: "the walk rows" },
] as const;

describe("warren-f566 polling fallback (GH #847)", () => {
	for (const { file, what } of SURFACES) {
		test(`${what} keeps the 45s fallback and no fast timer`, () => {
			const source = read(file);
			expect(source).toMatch(/refetchInterval: 45_000/);
			// Any literal under 45s means a surface went back to polling as its
			// primary freshness mechanism instead of the stream.
			expect(source).not.toMatch(/refetchInterval: (?:5000|5_000|3000|3_000)\b/);
		});
	}

	test("the per-row plan-run query polls on the fallback cadence, not per-row fast", () => {
		const source = read("plan-runs/walk-row.tsx");
		// The row key is a PREFIX match for the `["plan-runs"]` key the
		// invalidation hook busts, so the stream already refreshes these rows;
		// the timer is the public-mode fallback only.
		expect(source).toMatch(/queryKey: \["plan-runs", planRun\.id\]/);
		const row = source.slice(source.indexOf('queryKey: ["plan-runs", planRun.id]'));
		expect(row).toMatch(/refetchInterval: 45_000/);
	});

	test("the invalidation hook busts every key the fallback surfaces read", () => {
		const hook = readFileSync(
			join(import.meta.dir, "..", "ui", "src", "hooks", "use-lifecycle-stream-invalidation.ts"),
			"utf8",
		);
		for (const key of ["runs", "plan-runs"]) {
			expect(hook).toMatch(new RegExp(`queryKey: \\["${key}"\\]`));
		}
	});
});
