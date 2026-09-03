import { describe, expect, test } from "bun:test";
import { mainColumnClasses, sideRailClasses } from "./project-detail-layout.ts";

describe("ProjectDetailPage spectator layout", () => {
	test("operator keeps the fixed-width, no-shrink side rail", () => {
		const classes = sideRailClasses(true);
		expect(classes).toContain("shrink-0");
		expect(classes).toContain("lg:w-[336px]");
	});

	test("spectator rail drops shrink-0 and the fixed lg width so it fills the row", () => {
		const classes = sideRailClasses(false);
		expect(classes).not.toContain("shrink-0");
		expect(classes).not.toContain("lg:w-[336px]");
		expect(classes).toContain("w-full");
	});

	test("spectator page renders no main column (the operator flex-1 block)", () => {
		// The page only mounts the main column for an operator; a
		// spectator rendering it unconditionally would produce the
		// two-thirds blank column.
		expect(mainColumnClasses()).toContain("flex-1");
		expect(sideRailClasses(false)).not.toContain("flex-1");
	});
});
