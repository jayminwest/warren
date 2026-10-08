/**
 * Reproduction for warren-6bca. Below md the telemetry page rewrote every
 * `/#/telemetry/<tab>` URL to `/#/telemetry` and stacked all four tabs on
 * one scroll, so a link shared from a PR or a desktop landed a phone user
 * at the top of the page with the URL changed. Desktop kept the tab.
 *
 * Every width now routes the same way: the tab in the URL stays, it is the
 * selected tab, and picking another tab updates the hash as on desktop.
 *
 * Asserts on the URL and the DOM, never pixels.
 */

import { expect, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-6bca";
const TABS = ["loop", "behavior", "judge", "economics"] as const;

const { fixture, cases } = harnessCases();

for (const c of cases.filter((x) => x.page.id.startsWith("telemetry-") && x.theme === "light")) {
	const tab = c.page.id.replace("telemetry-", "");
	const other = TABS.find((t) => t !== tab) ?? "loop";

	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test(`keeps the /telemetry/${tab} deep link and can switch tabs`, async ({ page }) => {
			await openCase(page, c, fixture);
			expect(new URL(page.url()).hash, "the deep link survives").toBe(`#/telemetry/${tab}`);

			// The tab strip: the one nav that links to the tab routes.
			const nav = page
				.getByRole("navigation")
				.filter({ has: page.locator('a[href="#/telemetry/loop"]') });
			const current = nav.locator('a[aria-current="page"]');
			await expect(current, "the linked tab is selected").toHaveAttribute(
				"href",
				`#/telemetry/${tab}`,
			);
			await expect(current).toBeVisible();

			await nav.locator(`a[href="#/telemetry/${other}"]`).click();
			await expect
				.poll(() => new URL(page.url()).hash, { message: "a tab click updates the hash" })
				.toBe(`#/telemetry/${other}`);
		});
	});
}
