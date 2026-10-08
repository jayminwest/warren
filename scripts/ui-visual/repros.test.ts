import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Layout guard for the repro-first convention (warren-9fd7). Each UI bug
 * gets one `repros/<seed-id>.pw.ts` that the ui-visual harness runs. The
 * `.pw.ts` suffix matters: `bun test` loads any `.spec.ts`, and a
 * Playwright spec loaded there fails the root suite.
 */

const REPROS = join(import.meta.dir, "repros");
const ISSUE_TEMPLATE = join(import.meta.dir, "..", "..", ".github", "ISSUE_TEMPLATE", "ui-bug.yml");
const REPRO_FILE = /^(warren-[0-9a-f]{4,})\.pw\.ts$/;
/** playwright.config.ts `testMatch`. */
const PW_TEST_MATCH = /.*\.pw\.ts$/;

describe("ui-visual repros", () => {
	const entries = readdirSync(REPROS, { withFileTypes: true });

	test("holds at least the worked example", () => {
		expect(entries.map((e) => e.name)).toContain("warren-e9cd.pw.ts");
	});

	test("names every file <seed-id>.pw.ts so Playwright, not bun test, runs it", () => {
		const bad = entries
			.filter((e) => !e.isFile() || !REPRO_FILE.test(e.name) || !PW_TEST_MATCH.test(e.name))
			.map((e) => e.name);
		expect(bad).toEqual([]);
	});

	test("names its seed in each repro's source", () => {
		const unnamed = entries.flatMap((e) => {
			const seed = REPRO_FILE.exec(e.name)?.[1];
			if (seed === undefined) return [];
			return readFileSync(join(REPROS, e.name), "utf8").includes(seed) ? [] : [e.name];
		});
		expect(unnamed).toEqual([]);
	});
});

describe("ui-bug issue template", () => {
	const yml = readFileSync(ISSUE_TEMPLATE, "utf8");

	test("asks for page, viewport, theme, and a screenshot", () => {
		for (const id of ["page", "viewport", "theme", "screenshot"]) {
			expect(yml).toContain(`id: ${id}`);
		}
	});

	test("states the repro-first rule and where the spec goes", () => {
		expect(yml).toContain("scripts/ui-visual/repros/<seed-id>.pw.ts");
		expect(yml).toContain("fails before the fix");
	});
});
