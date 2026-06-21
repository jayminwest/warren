import { describe, expect, test } from "bun:test";
import {
	PHONE_MAX,
	PHONE_MIN,
	responsiveCardHeaderRow,
	responsiveFooterActions,
	responsiveFooterButton,
	responsiveFormControl,
	responsiveTable,
	responsiveTrailingControl,
	SM_BREAKPOINT,
} from "./responsive.ts";

describe("breakpoint contract", () => {
	test("orders phone floor below the phone target below the sm cutover", () => {
		expect(PHONE_MIN).toBeLessThan(PHONE_MAX);
		expect(PHONE_MAX).toBeLessThan(SM_BREAKPOINT);
	});

	test("pins the canonical phone targets", () => {
		expect(PHONE_MIN).toBe(360);
		expect(PHONE_MAX).toBe(393);
		expect(SM_BREAKPOINT).toBe(640);
	});
});

describe("wide-table-on-mobile tokens", () => {
	test("keeps cells on one line by default", () => {
		expect(responsiveTable.cellNoWrap).toContain("whitespace-nowrap");
	});

	test("caps and ellipsizes wide free-text columns", () => {
		expect(responsiveTable.cellTruncate).toContain("truncate");
		expect(responsiveTable.cellTruncate).toContain("max-w-");
	});
});

describe("layout tokens", () => {
	test("card header rows wrap controls to a second row", () => {
		expect(responsiveCardHeaderRow).toContain("flex-wrap");
		expect(responsiveCardHeaderRow).toContain("justify-between");
	});

	test("trailing control goes full-width on mobile then auto at sm", () => {
		expect(responsiveTrailingControl).toContain("w-full");
		expect(responsiveTrailingControl).toContain("sm:w-auto");
	});

	test("form controls meet the 44px touch target and 16px font floor", () => {
		expect(responsiveFormControl).toContain("h-11");
		expect(responsiveFormControl).toContain("text-base");
		expect(responsiveFormControl).toContain("sm:h-9");
		expect(responsiveFormControl).toContain("sm:text-sm");
	});

	test("footer actions stack on mobile and right-align at sm", () => {
		expect(responsiveFooterActions).toContain("flex-col");
		expect(responsiveFooterActions).toContain("sm:flex-row");
		expect(responsiveFooterActions).toContain("sm:justify-end");
		expect(responsiveFooterButton).toContain("w-full");
		expect(responsiveFooterButton).toContain("sm:w-auto");
	});
});
