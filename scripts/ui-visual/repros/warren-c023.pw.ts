/**
 * Reproduction for warren-c023. The UI leaked implementation notes as
 * visible mono captions ("NEWEST-RUNS WINDOW · FALLBACK POLL", "NO
 * PER-RUN TIMEOUT API YET", ...) and rendered a disabled Timeout field
 * for an API that does not exist. The phone bottom nav read "01 02 03 06
 * ··" because it reused the sidebar's ordinals.
 *
 * Captions say what the operator sees or can do, never how the code
 * fetches or resolves it. The bottom nav numbers its own five tabs 01-05.
 *
 * Asserts on rendered text, never pixels.
 */

import { expect, type Page, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-c023";

/** Implementation notes no caption may carry, matched case-insensitively. */
const LEAKED = [
	"NEWEST-RUNS WINDOW",
	"FALLBACK POLL",
	"BOUNDED POLL",
	"LIVE · REFRESHED",
	"PROJECT CONTEXT APPENDED",
	"ENFORCED FROM LIVE USAGE EVENTS",
	"WEAKEST:",
	"TIMEOUT API",
	"FREE TEXT",
	"UNBLOCKED ONLY",
	"SERVER WALKS",
] as const;

/** Pages that carried one of the captions above, at either width. */
const CAPTION_PAGES = ["operations", "dispatch", "dispatch-plan", "project-detail"];

const { fixture, cases } = harnessCases();

function leakedCaptions(page: Page): Promise<string[]> {
	return page.evaluate((leaked) => {
		const text = document.body.innerText.toUpperCase();
		return leaked.filter((note) => text.includes(note));
	}, LEAKED);
}

for (const c of cases.filter((x) => CAPTION_PAGES.includes(x.page.id) && x.theme === "light")) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("shows operator-facing captions, not implementation notes", async ({ page }) => {
			await openCase(page, c, fixture);
			expect(await leakedCaptions(page), "implementation notes on screen").toEqual([]);
			await expect(page.getByLabel(/^Timeout/), "no field for a missing API").toHaveCount(0);
		});
	});
}

for (const c of cases.filter(
	(x) => x.page.id === "operations" && x.viewport === "phone" && x.theme === "light",
)) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("numbers the bottom nav tabs 01-05", async ({ page }) => {
			await openCase(page, c, fixture);
			const nav = page.getByRole("navigation", { name: "Primary" });
			const ordinals = await nav.evaluate((el) =>
				[...el.children].map((tab) => (tab.firstElementChild?.textContent ?? "").trim()),
			);
			expect(ordinals).toEqual(["01", "02", "03", "04", "05"]);
		});
	});
}
