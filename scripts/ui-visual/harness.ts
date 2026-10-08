/**
 * Browser-side helpers every ui-visual spec shares (warren-99e1). The
 * smoke spec uses them today; the golden screenshots (warren-a132) and
 * the axe pass (warren-b629) reuse `harnessCases`, `openCase`, and
 * `screenshotMasks` so each layer loads a page the same way.
 *
 * Runs under the Playwright runner (Node), so it must stay free of Bun
 * APIs: import fixture modules type-only.
 */

import { join } from "node:path";
import { type Locator, type Page, type Request, type TestInfo, test } from "@playwright/test";

import type { FixtureBootOutput } from "./fixture-boot.ts";
import { FIXTURE_ENV, parseFixtureEnv } from "./fixture-env.ts";
import {
	expandManifest,
	GLOBAL_MASK_SELECTOR,
	PAGES,
	type PageCase,
	parseCaseFilter,
	validateManifest,
} from "./pages.ts";
import type { PageObservation } from "./smoke-checks.ts";

/** localStorage keys the SPA reads (src/ui/src/api/client.ts, hooks/use-theme.ts). */
const TOKEN_KEY = "warren.apiToken";
const THEME_KEY = "warren.theme";
/** How long a page may stay busy before assertions run anyway. */
const SETTLE_TIMEOUT_MS = 15_000;
/** A page is settled once it has been idle this long. */
const QUIET_MS = 300;
const POLL_MS = 50;
/** Long-lived event streams never finish, so they never count as in flight. */
const STREAM_URL = /[?&]follow=1\b|\/events\/stream\b/;

/** Screenshots land here (gitignored); CI uploads the directory. */
export function screenshotDir(info: TestInfo): string {
	return join(info.project.testDir, "out", "screenshots");
}

/** The fixture plus the expanded, filtered manifest. Throws on a bad manifest. */
export function harnessCases(env: NodeJS.ProcessEnv = process.env): {
	fixture: FixtureBootOutput;
	cases: PageCase[];
} {
	const fixture = parseFixtureEnv(env[FIXTURE_ENV]);
	const errors = validateManifest(PAGES, fixture.ids);
	if (errors.length > 0) throw new Error(`invalid ui-visual manifest:\n${errors.join("\n")}`);
	return { fixture, cases: expandManifest(PAGES, fixture.ids, parseCaseFilter(env)) };
}

/**
 * Pin the clock, seed theme and token, navigate, and wait for the page to
 * settle. Returns the live list of console errors and page errors; it
 * keeps filling until the page closes, so read it last.
 */
export async function openCase(
	page: Page,
	c: PageCase,
	fixture: FixtureBootOutput,
): Promise<string[]> {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() !== "error") return;
		const loc = msg.location();
		const where = loc.url === "" ? "" : ` (${loc.url}:${loc.lineNumber})`;
		errors.push(`console.error: ${msg.text()}${where}`);
	});
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	await page.clock.setFixedTime(fixture.frozenNowMs);
	await page.addInitScript(
		({ tokenKey, themeKey, token, theme }) => {
			localStorage.setItem(themeKey, theme);
			if (token === null) localStorage.removeItem(tokenKey);
			else localStorage.setItem(tokenKey, token);
		},
		{
			tokenKey: TOKEN_KEY,
			themeKey: THEME_KEY,
			token: c.page.authenticated === false ? null : fixture.token,
			theme: c.theme,
		},
	);
	const inFlight = trackRequests(page);
	await page.goto(`${fixture.baseUrl}${c.url}`);
	await settle(page, inFlight);
	return errors;
}

/** The live set of non-stream requests the page has not finished. */
function trackRequests(page: Page): ReadonlySet<Request> {
	const inFlight = new Set<Request>();
	page.on("request", (req) => {
		if (!STREAM_URL.test(req.url())) inFlight.add(req);
	});
	const done = (req: Request): void => {
		inFlight.delete(req);
	};
	page.on("requestfinished", done);
	page.on("requestfailed", done);
	return inFlight;
}

/** True while `#root` is empty or a spinner (`.animate-spin`) is in the DOM. */
function domBusy(page: Page): Promise<boolean> {
	return page.evaluate(
		() =>
			(document.querySelector("#root")?.childElementCount ?? 0) === 0 ||
			document.querySelector(".animate-spin") !== null,
	);
}

/**
 * Wait until no request is in flight (streams aside), `#root` has
 * rendered, and no spinner shows, held for `QUIET_MS`; then for web fonts.
 * A page that never settles is not a failure here: the smoke checks and
 * the screenshot report what it looked like, and the test is annotated.
 */
async function settle(page: Page, inFlight: ReadonlySet<Request>): Promise<void> {
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	let quietSince: number | null = null;
	let settled = false;
	while (!settled && Date.now() < deadline) {
		const busy = inFlight.size > 0 || (await domBusy(page));
		if (busy) quietSince = null;
		else quietSince ??= Date.now();
		settled = quietSince !== null && Date.now() - quietSince >= QUIET_MS;
		if (!settled) await page.waitForTimeout(POLL_MS);
	}
	if (!settled) {
		const pending = [...inFlight].map((r) => r.url()).join(", ");
		test.info().annotations.push({
			type: "unsettled",
			description: `still busy after ${SETTLE_TIMEOUT_MS}ms${pending === "" ? "" : `: ${pending}`}`,
		});
	}
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Read the DOM facts the smoke checks judge. */
export async function observe(
	page: Page,
	consoleErrors: readonly string[],
): Promise<PageObservation> {
	const dom = await page.evaluate(() => ({
		scrollers: ["html", "main"].flatMap((selector) => {
			const el = document.querySelector(selector);
			return el === null
				? []
				: [{ selector, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }];
		}),
		rootChildCount: document.querySelector("#root")?.childElementCount ?? 0,
		bodyText: document.body.innerText,
	}));
	return { ...dom, consoleErrors: [...consoleErrors] };
}

/** Locators masked in every screenshot of this case. */
export function screenshotMasks(page: Page, c: PageCase): Locator[] {
	return [GLOBAL_MASK_SELECTOR, ...(c.page.mask ?? [])].map((s) => page.locator(s));
}

/** Cap on how far a screenshot grows the viewport to fit `<main>`. */
const MAX_EXTRA_HEIGHT = 8_000;

/**
 * Full-page, animation-free screenshot into `screenshotDir`. The console
 * shell pins itself to the viewport and scrolls inside `<main>`, so
 * `fullPage` alone would stop at the fold: grow the viewport by what
 * `<main>` hides, shoot, then restore the case's size.
 */
export async function screenshotCase(page: Page, c: PageCase, info: TestInfo): Promise<void> {
	const path = join(screenshotDir(info), `${c.name}.png`);
	const hidden = await page.evaluate(() => {
		const main = document.querySelector("main");
		return main === null ? 0 : main.scrollHeight - main.clientHeight;
	});
	const extra = Math.min(Math.max(0, hidden), MAX_EXTRA_HEIGHT);
	if (extra > 0) {
		await page.setViewportSize({ width: c.size.width, height: c.size.height + extra });
		await nextFrames(page);
	}
	await page.screenshot({
		path,
		fullPage: true,
		animations: "disabled",
		caret: "hide",
		mask: screenshotMasks(page, c),
	});
	if (extra > 0) {
		await page.setViewportSize(c.size);
		await nextFrames(page);
	}
	await info.attach(c.name, { path, contentType: "image/png" });
}

/** Let layout and paint catch up after a resize. */
function nextFrames(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
