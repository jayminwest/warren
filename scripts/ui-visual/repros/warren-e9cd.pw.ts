/**
 * Reproduction for warren-e9cd (the worked example of the repro-first
 * convention, warren-9fd7). Telemetry > Delivery > "Run outcomes" drew one
 * column per day that had runs, so the column count, the column widths, and
 * the axis disagreed with the "14 DAYS" window. Below md it also folded the
 * days into Monday weeks, so a 14-day window read "AUG 31 -> SEP 14".
 *
 * The fix pads the series to one column per UTC day in the window (weekly
 * only at 90 days, on every width) and opens the window at UTC midnight.
 *
 * Asserts on layout and text, never pixels, so it is deterministic on a
 * laptop and in the CI container alike.
 */

import { expect, type Page, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "warren-e9cd";
/** DEFAULT_TELEMETRY_RANGE_DAYS in src/ui/src/pages/telemetry/use-telemetry-window.tsx. */
const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Days the sparse variant keeps, like the four columns seen on app.warren.run. */
const SPARSE_DAYS = 4;

const { fixture, cases } = harnessCases();

/** "SEP 2": the axis label for the UTC day `offset` days before the frozen today. */
function axisLabel(offset: number): string {
	const now = new Date(fixture.frozenNowMs);
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return new Date(today - offset * DAY_MS)
		.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
		.toUpperCase();
}

interface ChartFacts {
	readonly columns: number;
	readonly widths: readonly number[];
	/** Pixels the columns stick out past the chart box, left or right. */
	readonly overhang: number;
	readonly axis: readonly string[];
}

/**
 * Columns carry a "<day>: N succeeded · N cancelled · N failed" title. The
 * page mounts the tab twice (stacked below md, routed above it) and hides
 * one copy, so count only the rendered columns.
 */
function readChart(page: Page): Promise<ChartFacts> {
	return page.evaluate(() => {
		const cols = [...document.querySelectorAll<HTMLElement>('[title*=" succeeded · "]')].filter(
			(c) => c.getClientRects().length > 0,
		);
		const chart = cols[0]?.parentElement ?? null;
		const box = chart?.getBoundingClientRect();
		const rects = cols.map((c) => c.getBoundingClientRect());
		const overhang =
			box === undefined
				? 0
				: Math.max(0, ...rects.map((r) => Math.max(box.left - r.left, r.right - box.right)));
		const axis = chart?.nextElementSibling;
		return {
			columns: cols.length,
			widths: rects.map((r) => r.width),
			overhang,
			axis: axis ? [...axis.children].map((e) => (e.textContent ?? "").trim().toUpperCase()) : [],
		};
	});
}

function expectOneColumnPerDay(chart: ChartFacts): void {
	expect(chart.columns, "one column per day in the window").toBe(WINDOW_DAYS);
	const spread = Math.max(...chart.widths) - Math.min(...chart.widths);
	expect(spread, "uniform column widths").toBeLessThanOrEqual(1);
	expect(chart.overhang, "columns stay inside the chart").toBeLessThanOrEqual(0.5);
	expect(chart.axis, "axis spans the window").toEqual([axisLabel(WINDOW_DAYS - 1), axisLabel(0)]);
}

for (const c of cases.filter((x) => x.page.id === "telemetry-loop" && x.theme === "light")) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("draws one column per day for the fixture's runs", async ({ page }) => {
			await openCase(page, c, fixture);
			expectOneColumnPerDay(await readChart(page));
		});

		test("pads zero-run days when the server sends sparse buckets", async ({ page }) => {
			// Keep only the newest few buckets, the shape production returned.
			await page.route("**/analytics/runs?**", async (route) => {
				const res = await route.fetch();
				const body = (await res.json()) as { timeSeries?: { key: string }[] };
				const series = [...(body.timeSeries ?? [])].sort((a, b) => a.key.localeCompare(b.key));
				body.timeSeries = series.slice(-SPARSE_DAYS);
				await route.fulfill({ response: res, json: body });
			});
			await openCase(page, c, fixture);
			expectOneColumnPerDay(await readChart(page));
		});
	});
}
