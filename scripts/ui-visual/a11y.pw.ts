/**
 * Accessibility assertions across the page manifest (warren-b629). For
 * each page x viewport x theme, axe-core runs the WCAG 2.0 A and AA rules
 * against the settled page and fails on any `serious` or `critical`
 * violation that `a11y-allowlist.json` does not grandfather. A
 * grandfathered violation that stops reproducing also fails, so the
 * allowlist only shrinks.
 *
 * Named `*.pw.ts`, not `*.spec.ts`, because `bun test` also discovers
 * `.spec.` files. Run it through `bun run check:ui-visual`.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
	AXE_TAGS,
	blockingViolations,
	formatA11yVerdict,
	loadAllowlist,
	reconcileA11y,
} from "./a11y-checks.ts";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
const allowlist = loadAllowlist();

for (const c of cases) {
	test.describe(c.name, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("a11y", async ({ page }, info) => {
			await openCase(page, c, fixture);
			const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
			const verdict = reconcileA11y(c, blockingViolations(results.violations), allowlist);
			for (const e of verdict.tolerated) {
				info.annotations.push({
					type: "known-a11y-violation",
					description: `${e.rule} (${e.seed}): ${e.reason}`,
				});
			}
			expect(formatA11yVerdict(c.name, verdict)).toBe("");
		});
	});
}
