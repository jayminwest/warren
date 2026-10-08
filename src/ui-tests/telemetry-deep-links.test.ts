/**
 * Telemetry tab deep links survive every viewport (warren-6bca).
 *
 * The phone layout used to flatten /telemetry/<tab> to /telemetry on
 * narrow screens, so a link shared from a PR landed on the wrong place
 * and the URL was rewritten. The rendered behaviour is pinned by
 * scripts/ui-visual/repros/warren-6bca.pw.ts; this guard pins the source:
 * nothing in the telemetry page reads the viewport to redirect a tab.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PAGES = join(import.meta.dir, "..", "ui", "src", "pages");
const telemetryFiles = [
	join(PAGES, "telemetry.tsx"),
	...readdirSync(join(PAGES, "telemetry"))
		.filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
		.map((f) => join(PAGES, "telemetry", f)),
];

describe("telemetry deep links (warren-6bca)", () => {
	test("never redirects a tab route to the bare /telemetry path", () => {
		const page = readFileSync(join(PAGES, "telemetry.tsx"), "utf8");
		expect(page).not.toMatch(/<Navigate\s+to="\/telemetry"/);
		expect(page).not.toMatch(/useLocation/);
	});

	test("branches no telemetry module's routing on viewport width", () => {
		for (const file of telemetryFiles) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/useIsDesktop|matchMedia|innerWidth/);
		}
		expect(existsSync(join(PAGES, "telemetry", "use-is-desktop.ts"))).toBe(false);
	});

	test("keeps a child route per tab and opens the first tab from the index", () => {
		const app = readFileSync(join(import.meta.dir, "..", "ui", "src", "app.tsx"), "utf8");
		for (const tab of ["loop", "behavior", "judge", "economics"]) {
			expect(app).toMatch(new RegExp(`path="${tab}"`));
		}
		const page = readFileSync(join(PAGES, "telemetry.tsx"), "utf8");
		expect(page).toMatch(/<Navigate to="\/telemetry\/loop" replace \/>/);
	});
});
