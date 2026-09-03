import { describe, expect, test } from "bun:test";
import { mainColumnClasses, sideRailClasses } from "./project-detail-layout.ts";

describe("ProjectDetailPage layout (warren-b754)", () => {
	test("the side rail is fixed-width and no-shrink for every audience", () => {
		// warren-b754 made the warren-config + ready-plans reads
		// `readPublic`, so the main column renders for spectators too and
		// the warren-cd42 rail-fills-the-row variant is gone.
		const classes = sideRailClasses();
		expect(classes).toContain("shrink-0");
		expect(classes).toContain("lg:w-[336px]");
	});

	test("the main column is the flex-1 panel column", () => {
		expect(mainColumnClasses()).toContain("flex-1");
	});
});
