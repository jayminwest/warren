/**
 * Reproduction for warren-40f1. The FOUC theme guard was an inline
 * `<script>` in `src/ui/index.html`, but the server sends
 * `script-src 'self'` with no hash or nonce, so the browser refused it:
 * four CSP violations on every page load, and `<html data-theme>` stayed
 * unset until React mounted, so a dark-theme user saw a light flash.
 *
 * Main already carries the fix: warren-99e1 (#1350) moved the guard to
 * `src/ui/public/theme-init.js`, an external classic script the policy
 * allows. This spec pins it. It was green when it landed; it fails
 * against the pre-#1350 `index.html` with the inline script restored.
 *
 * Asserts on headers, CSP events, and the DOM, never pixels.
 */

import { expect, type Page, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-40f1";

const { fixture, cases } = harnessCases();

interface FirstPaintFacts {
	/** `<html data-theme>` when the parser inserted `<body>`, before any module script ran. */
	readonly themeAtBody: string | null;
	/** `#root` children at that moment: 0 proves React had not mounted yet. */
	readonly rootChildrenAtBody: number | null;
	/** `securitypolicyviolation` events the page fired, as "directive blocked-uri". */
	readonly violations: readonly string[];
}

/**
 * Record the theme the moment `<body>` lands and every CSP violation. Runs
 * before any page script, so it sees what the first paint would see.
 */
async function recordFirstPaint(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const facts: {
			themeAtBody: string | null;
			rootChildrenAtBody: number | null;
			violations: string[];
		} = { themeAtBody: null, rootChildrenAtBody: null, violations: [] };
		(window as unknown as { __warren40f1: typeof facts }).__warren40f1 = facts;
		document.addEventListener("securitypolicyviolation", (e) => {
			facts.violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
		});
		const observer = new MutationObserver(() => {
			if (document.body === null) return;
			facts.themeAtBody = document.documentElement.dataset.theme ?? null;
			facts.rootChildrenAtBody = document.querySelector("#root")?.childElementCount ?? 0;
			observer.disconnect();
		});
		observer.observe(document, { childList: true, subtree: true });
	});
}

function readFirstPaint(page: Page): Promise<FirstPaintFacts> {
	return page.evaluate(() => (window as unknown as { __warren40f1: FirstPaintFacts }).__warren40f1);
}

for (const c of cases.filter((x) => x.page.id === "operations" && x.viewport === "desktop")) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("the theme resolves before first paint under the server CSP", async ({ page }) => {
			const doc = page.waitForResponse((r) => r.request().resourceType() === "document");
			await recordFirstPaint(page);
			const errors = await openCase(page, c, fixture);

			const csp = (await doc).headers()["content-security-policy"] ?? "";
			const scriptSrc = csp
				.split(";")
				.map((d) => d.trim())
				.find((d) => d.startsWith("script-src "));
			expect(scriptSrc, "the SPA document carries the strict script policy").toBe(
				"script-src 'self'",
			);

			const facts = await readFirstPaint(page);
			expect(facts.violations, "no CSP violations").toEqual([]);
			expect(facts.rootChildrenAtBody, "measured before React mounted").toBe(0);
			expect(facts.themeAtBody, "data-theme set before first paint").toBe(c.theme);
			expect(errors.filter((e) => e.includes("Content Security Policy"))).toEqual([]);
		});
	});
}
