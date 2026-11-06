/**
 * Reproduction for warren-8ee5, the lifecycle stream part. The global
 * lifecycle stream (`GET /events/stream`, `readOperator`) is mounted once
 * above the router. It opened on the login page with no token, got a 401,
 * and stopped for good. Signing in moved the tab to the console without a
 * reload, so the stream never opened again: the list pages fell back to the
 * slow poll until the operator reloaded the tab.
 *
 * The fix opens the stream only while `/whoami` grants `readOperator`, and
 * opens it again when a sign-in grants it.
 *
 * Asserts on requests, never pixels.
 */

import { expect, type Page, type Request, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-8ee5";
const STREAM = /\/events\/stream\b/;
/** Time for the post-sign-in console to open the stream. */
const OPEN_TIMEOUT_MS = 10_000;

const { fixture, cases } = harnessCases();

/** Every lifecycle stream request the page sends, in order. */
function recordStreams(page: Page): Request[] {
	const seen: Request[] = [];
	page.on("request", (req) => {
		if (STREAM.test(req.url())) seen.push(req);
	});
	return seen;
}

function bearer(req: Request): string | null {
	return req.headers().authorization ?? null;
}

for (const c of cases.filter((x) => x.page.id === "login" && x.theme === "light")) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("the login page does not open the lifecycle stream without a token", async ({ page }) => {
			const streams = recordStreams(page);
			await openCase(page, c, fixture);
			expect(streams.map(bearer), "lifecycle stream requests before sign-in").toEqual([]);
		});

		test("sign-in opens the lifecycle stream with the new token", async ({ page }) => {
			const streams = recordStreams(page);
			await openCase(page, c, fixture);
			const before = streams.length;
			await page.getByLabel("API TOKEN").fill(fixture.token);
			await page.getByRole("button", { name: "Sign in" }).click();
			await page.waitForURL(/#\/operations$/);
			await expect
				.poll(() => streams.slice(before).map(bearer), {
					message: "lifecycle stream requests after sign-in",
					timeout: OPEN_TIMEOUT_MS,
				})
				.toContain(`Bearer ${fixture.token}`);
		});
	});
}
