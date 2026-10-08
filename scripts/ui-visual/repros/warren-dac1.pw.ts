/**
 * Reproduction for warren-dac1. Two cards stretched to the height of their
 * row neighbour and left a hollow band below their content: the Services
 * card on Operations (beside the taller Lifecycle snapshot) and the Child
 * walk card on plan-run detail (beside the taller rail). Both parents were
 * flex rows with the default `align-items: stretch`.
 *
 * A card sized to its content keeps the same height when it is pinned to
 * `align-self: flex-start`. The spec measures the card as rendered, pins
 * it, measures again, and asserts the two heights agree.
 *
 * Desktop only: on a phone both rows stack into one column, where stretch
 * acts on width, not height. Asserts on layout, never pixels.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-dac1";

const { fixture, cases } = harnessCases();

/** Pixels the card is taller than its content-sized self. */
function stretchedBy(card: Locator): Promise<number> {
	return card.evaluate((el: HTMLElement) => {
		const rendered = el.getBoundingClientRect().height;
		const previous = el.style.alignSelf;
		el.style.alignSelf = "flex-start";
		const natural = el.getBoundingClientRect().height;
		el.style.alignSelf = previous;
		return rendered - natural;
	});
}

const TARGETS = [
	{
		page: "operations",
		card: "Services",
		locate: (p: Page) => p.getByText("Services", { exact: true }).locator("xpath=../.."),
	},
	{
		page: "plan-run-detail",
		card: "Child walk",
		locate: (p: Page) =>
			p.getByRole("heading", { name: "Child walk" }).locator("xpath=ancestor::section[1]"),
	},
] as const;

for (const target of TARGETS) {
	for (const c of cases.filter(
		(x) => x.page.id === target.page && x.viewport === "desktop" && x.theme === "light",
	)) {
		test.describe(`${SEED} ${c.name}`, () => {
			test.use({ viewport: c.size, colorScheme: c.theme });

			test(`the ${target.card} card is as tall as its content`, async ({ page }) => {
				await openCase(page, c, fixture);
				const card = target.locate(page);
				await expect(card).toBeVisible();
				expect(
					await stretchedBy(card),
					`${target.card} stretched below its content`,
				).toBeLessThanOrEqual(1);
			});
		});
	}
}
