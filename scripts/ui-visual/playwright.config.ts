/**
 * Playwright config for the ui-visual harness (warren-99e1). Chromium
 * only. Specs are `*.pw.ts` so `bun test` (which discovers `*.spec.ts`)
 * never loads them. Run through `bun run check:ui-visual`, which boots
 * the fixture and exports `WARREN_UI_VISUAL_FIXTURE`; Playwright itself
 * runs under Node via `bunx playwright test` (oven-sh/bun#8222).
 */

import { defineConfig, devices } from "@playwright/test";

const isCi = process.env.CI !== undefined && process.env.CI !== "";
const workers = Number(process.env.WARREN_UI_VISUAL_WORKERS ?? (isCi ? 2 : 4));

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.pw\.ts$/,
	outputDir: "./out/test-results",
	// Golden baselines (warren-a132) live beside the harness, one file per
	// manifest case: `toHaveScreenshot(\`${c.name}.png\`)`.
	snapshotPathTemplate: "{testDir}/__golden__/{arg}{ext}",
	fullyParallel: true,
	forbidOnly: isCi,
	retries: 0,
	workers: Number.isInteger(workers) && workers > 0 ? workers : 1,
	timeout: 60_000,
	reporter: [["list"], ["html", { outputFolder: "out/report", open: "never" }]],
	// Pin what the host would otherwise leak into rendered dates and numbers.
	use: { trace: "retain-on-failure", timezoneId: "UTC", locale: "en-US" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
