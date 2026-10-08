/**
 * Golden screenshots across the page manifest (warren-a132, plan pl-10db
 * step 10). Each golden case loads exactly as the smoke spec does
 * (`openCase`), then `toHaveScreenshot` compares the full page against
 * `scripts/ui-visual/__golden__/<page>-<viewport>-<theme>.png`.
 *
 * Runs only inside the ui-visual workflow's pinned Playwright container
 * (`goldenGate`). Anywhere else this file registers one skipped test with
 * the reason, and the smoke spec still runs. Baselines are regenerated
 * only by that workflow (`update_goldens`), never on a laptop; the guard
 * in `goldens.ts` rejects a set without a matching generator manifest.
 *
 * On a mismatch the expected, actual, and diff images land in
 * `out/golden-diff/<case>/` with a `result.json`, a fixed layout for
 * warren-70d9's PR comment and warren-4780's approval flow.
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";

import {
	diffKind,
	GOLDEN_DIFF_DIR,
	goldenFileName,
	goldenGate,
	isGoldenPair,
} from "./golden-cases.ts";
import { atContentHeight, harnessCases, openCase, screenshotMasks } from "./harness.ts";
import type { PageCase } from "./pages.ts";

/** Share of pixels that may differ (anti-aliasing noise) before a case fails. */
const MAX_DIFF_PIXEL_RATIO = 0.01;
/** `toHaveScreenshot` retakes until two shots agree; full pages need longer than 5s. */
const SCREENSHOT_TIMEOUT_MS = 20_000;

const gate = goldenGate(process.env, process.platform, process.arch);

if (gate.enabled) {
	const { fixture, cases } = harnessCases();
	for (const c of cases.filter((x) => isGoldenPair(x.viewport, x.theme))) {
		test.describe(c.name, () => {
			test.use({ viewport: c.size, colorScheme: c.theme });
			// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixtures argument.
			test.afterEach(async ({}, info) => exportDiff(c, info));

			test("golden", async ({ page }) => {
				await openCase(page, c, fixture);
				await atContentHeight(page, c, () =>
					expect(page).toHaveScreenshot(goldenFileName(c.name), {
						fullPage: true,
						animations: "disabled",
						caret: "hide",
						mask: screenshotMasks(page, c),
						maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
						timeout: SCREENSHOT_TIMEOUT_MS,
					}),
				);
			});
		});
	}
} else {
	test("golden screenshots", () => {
		test.skip(true, gate.reason);
	});
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Copy a failed case's expected/actual/diff images to `out/golden-diff/<case>/`. */
async function exportDiff(c: PageCase, info: TestInfo): Promise<void> {
	if (info.status === info.expectedStatus) return;
	const images = info.attachments.flatMap((a) => {
		const kind = diffKind(a.name);
		return kind !== null && a.path !== undefined ? [{ kind, path: a.path }] : [];
	});
	if (images.length === 0) return;
	const dir = join(info.project.testDir, "out", GOLDEN_DIFF_DIR, c.name);
	await mkdir(dir, { recursive: true });
	for (const image of images) await copyFile(image.path, join(dir, `${image.kind}.png`));
	const result = {
		case: c.name,
		page: c.page.id,
		viewport: c.viewport,
		theme: c.theme,
		url: c.url,
		golden: `scripts/ui-visual/__golden__/${goldenFileName(c.name)}`,
		images: images.map((i) => `${i.kind}.png`).sort(),
		error: (info.error?.message ?? "").replace(ANSI, ""),
	};
	await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, "\t")}\n`);
}
