/**
 * Smoke assertions across the page manifest (warren-99e1). For each
 * page x viewport x theme: zero console errors and page errors, no
 * horizontal overflow, a non-empty `#root`, and no "undefined" / "NaN" /
 * "[object Object]" in the body text. Every case also writes a full-page
 * screenshot to `scripts/ui-visual/out/screenshots/`.
 *
 * Named `*.pw.ts`, not `*.spec.ts`, because `bun test` also discovers
 * `.spec.` files. Run it through `bun run check:ui-visual`.
 */

import { expect, test } from "@playwright/test";

import { harnessCases, observe, openCase, screenshotCase } from "./harness.ts";
import { evaluateSmoke, formatVerdict, reconcile } from "./smoke-checks.ts";

const { fixture, cases } = harnessCases();

for (const c of cases) {
	test.describe(c.name, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("smoke", async ({ page }, info) => {
			const errors = await openCase(page, c, fixture);
			await screenshotCase(page, c, info);
			const verdict = reconcile(c, evaluateSmoke(await observe(page, errors)));
			for (const k of verdict.tolerated) {
				info.annotations.push({
					type: "known-failure",
					description: `${k.check} (${k.seed}): ${k.reason}`,
				});
			}
			expect(formatVerdict(c.name, verdict)).toBe("");
		});
	});
}
