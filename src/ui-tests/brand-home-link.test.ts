import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The UI has no DOM test harness; pin the shared shell's link contract.
describe("console brand navigation", () => {
	for (const file of ["console-shell.tsx", "console-sidebar.tsx"]) {
		test(`links the logo and wordmark home in ${file}`, () => {
			const source = readFileSync(
				new URL(`../ui/src/components/console/${file}`, import.meta.url),
				"utf8",
			);
			expect(source).toMatch(
				/<Link\s+to="\/"\s+aria-label="Warren home"[\s\S]*?<WarrenLogo[\s\S]*?warren[\s\S]*?<\/Link>/,
			);
		});
	}

	test("closes the mobile drawer when its brand is activated", () => {
		const source = readFileSync(
			new URL("../ui/src/components/console/console-sidebar.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain("<BrandRow onNavigate={onNavigate} />");
		expect(source).toMatch(/aria-label="Warren home"\s+onClick={onNavigate}/);
	});
});
