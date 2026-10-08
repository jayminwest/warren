/**
 * Reproduction for warren-3de0: three phone-width layout defects.
 *
 * 1. Project detail: the header put the git URL and "Refresh clone" on one
 *    row and orphaned "Delete" on a row of its own. Both actions belong on
 *    one row, below the URL.
 * 2. Dispatch: Agent and Model shared a two-column row below `sm:`, so the
 *    Model placeholder clipped mid-word. The pair stacks below `sm:`.
 * 3. Runs: the mobile runs card sat 14px further in than the "All /
 *    + Filter" pill strip above it, so their left edges disagreed.
 *
 * Runs at both phone targets from `components/ui/responsive.ts`: 393px
 * (the manifest's phone case) and 360px. Asserts on layout, never pixels.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";
import type { PageCase } from "../pages.ts";

const SEED = "warren-3de0";
/** PHONE_MIN in src/ui/src/components/ui/responsive.ts. */
const PHONE_MIN = 360;
/** The Model input's placeholder in src/ui/src/pages/dispatch/dispatch-form.tsx. */
const MODEL_PLACEHOLDER = "claude-sonnet-4-6, gpt-4o, …";

const { fixture, cases } = harnessCases();

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
	const b = await locator.boundingBox();
	if (b === null) throw new Error(`${locator.toString()} has no layout box`);
	return b;
}

function noHorizontalOverflow(page: Page): Promise<boolean> {
	return page.evaluate(
		() => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
	);
}

/** The phone cases at 393px, plus the same cases narrowed to 360px. */
function phoneCases(pageId: string): { c: PageCase; width: number }[] {
	return cases
		.filter((x) => x.page.id === pageId && x.viewport === "phone" && x.theme === "light")
		.flatMap((c) => [
			{ c, width: c.size.width },
			{ c, width: PHONE_MIN },
		]);
}

/**
 * Git URLs to render in the header: the fixture's own, a short one (where
 * the URL and "Refresh clone" fit one row and "Delete" wrapped alone, as
 * seen on app.warren.run), and one too long for any phone row.
 */
const GIT_URLS: readonly (string | null)[] = [
	null,
	"https://github.com/acme/web.git",
	"https://github.com/an-organization-with-a-long-name/a-repository-with-a-long-name.git",
];

/** Serve the project row with `gitUrl` swapped in. */
async function withGitUrl(page: Page, gitUrl: string): Promise<void> {
	await page.route(
		(url) => /\/projects\/[^/]+$/.test(url.pathname),
		async (route) => {
			const res = await route.fetch();
			const body = (await res.json()) as Record<string, unknown>;
			await route.fulfill({ response: res, json: { ...body, gitUrl } });
		},
	);
}

for (const { c, width } of phoneCases("project-detail")) {
	for (const gitUrl of GIT_URLS) {
		const label = gitUrl === null ? "the fixture URL" : `a ${gitUrl.length}-char URL`;
		test.describe(`${SEED} ${c.name} @${width}`, () => {
			test.use({ viewport: { width, height: c.size.height }, colorScheme: c.theme });

			test(`keeps the header actions together below ${label}`, async ({ page }) => {
				if (gitUrl !== null) await withGitUrl(page, gitUrl);
				await openCase(page, c, fixture);
				// The header row is the h1's parent; the facts rail repeats the URL.
				const header = page.getByRole("heading", { level: 1 }).locator("xpath=..");
				const row = await box(header);
				const url = await box(header.getByText(/^https:\/\/github\.com\/.+\.git$/));
				const refresh = await box(header.getByRole("button", { name: "Refresh clone" }));
				const del = await box(header.getByRole("button", { name: "Delete" }));
				expect(Math.abs(refresh.y - del.y), "both actions on one row").toBeLessThanOrEqual(1);
				expect(url.y + url.height, "the URL sits above the actions").toBeLessThanOrEqual(
					refresh.y + 0.5,
				);
				expect(url.x + url.width, "the URL truncates inside the row").toBeLessThanOrEqual(
					row.x + row.width + 0.5,
				);
				expect(
					Math.abs(del.x + del.width - (row.x + row.width)),
					"the actions are right-aligned",
				).toBeLessThanOrEqual(1);
				expect(await noHorizontalOverflow(page), "no horizontal overflow").toBe(true);
			});
		});
	}
}

for (const { c, width } of phoneCases("dispatch")) {
	test.describe(`${SEED} ${c.name} @${width}`, () => {
		test.use({ viewport: { width, height: c.size.height }, colorScheme: c.theme });

		test("stacks Agent over Model and never clips the Model placeholder", async ({ page }) => {
			await openCase(page, c, fixture);
			const agent = page.locator("#dispatch-agent");
			const model = page.getByPlaceholder(MODEL_PLACEHOLDER);
			const a = await box(agent);
			const m = await box(model);
			expect(m.y, "Model starts below Agent").toBeGreaterThanOrEqual(a.y + a.height);
			const fit = await model.evaluate((el: HTMLInputElement) => {
				const s = getComputedStyle(el);
				const ctx = document.createElement("canvas").getContext("2d");
				if (ctx === null) return { text: 0, room: 0 };
				ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
				const room =
					el.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
				return { text: ctx.measureText(el.placeholder).width, room };
			});
			expect(fit.text, "the Model placeholder fits its input").toBeLessThanOrEqual(fit.room);
			expect(await noHorizontalOverflow(page), "no horizontal overflow").toBe(true);
		});
	});
}

for (const { c, width } of phoneCases("runs")) {
	test.describe(`${SEED} ${c.name} @${width}`, () => {
		test.use({ viewport: { width, height: c.size.height }, colorScheme: c.theme });

		test("aligns the runs card with the filter strip on the page gutter", async ({ page }) => {
			await openCase(page, c, fixture);
			const strip = await box(page.getByTestId("runs-mobile-filter-strip"));
			// The card's column strip ends in "ELAPSED · COST"; the card is two levels up.
			const card = await box(
				page.getByText("ELAPSED · COST", { exact: true }).locator("xpath=../.."),
			);
			expect(Math.abs(card.x - strip.x), "left edges agree").toBeLessThanOrEqual(0.5);
			expect(
				Math.abs(card.x + card.width - (strip.x + strip.width)),
				"right edges agree",
			).toBeLessThanOrEqual(0.5);
			expect(await noHorizontalOverflow(page), "no horizontal overflow").toBe(true);
		});
	});
}
