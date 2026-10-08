import { describe, expect, test } from "bun:test";

import {
	type A11yAllowEntry,
	type A11yViolation,
	type AxeResultLike,
	blockingViolations,
	formatA11yVerdict,
	formatViolation,
	loadAllowlist,
	parseAllowlist,
	reconcileA11y,
} from "./a11y-checks.ts";
import { PAGES, type PageSpec, THEMES, VIEWPORT_NAMES } from "./pages.ts";

/**
 * The allowlist ratchet: the entry count may only go down. Lower this in
 * the PR that deletes an entry; raising it needs review justification and
 * a tracker id on the new entry.
 */
const ALLOWLIST_CEILING = 1;

const RUNS: PageSpec = { id: "runs", route: "/runs", path: () => "/runs" };
const CASE = { page: RUNS, viewport: "phone", theme: "dark" } as const;

function axe(id: string, impact: string | null, targets: string[][] = [["#a"]]): AxeResultLike {
	return {
		id,
		impact,
		help: `${id} help`,
		helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
		nodes: targets.map((target) => ({ target })),
	};
}

function violation(rule: string): A11yViolation {
	return { rule, impact: "serious", help: `${rule} help`, helpUrl: "https://x", targets: ["#a"] };
}

function entry(rule: string, extra: Partial<A11yAllowEntry> = {}): A11yAllowEntry {
	return { page: "runs", rule, seed: "warren-23b5", reason: "tracked", ...extra };
}

describe("blockingViolations", () => {
	test("keeps serious and critical, drops minor, moderate, and unknown impacts", () => {
		const out = blockingViolations([
			axe("color-contrast", "serious"),
			axe("select-name", "critical"),
			axe("region", "moderate"),
			axe("landmark-one-main", "minor"),
			axe("odd", null),
		]);
		expect(out.map((v) => v.rule)).toEqual(["color-contrast", "select-name"]);
	});

	test("flattens node targets, joining shadow and iframe paths", () => {
		const [v] = blockingViolations([axe("label", "critical", [["#x"], ["iframe", "#y"]])]);
		expect(v?.targets).toEqual(["#x", "iframe >>> #y"]);
		expect(v?.helpUrl).toContain("/label");
	});
});

describe("reconcileA11y", () => {
	test("passes a clean case with no entries", () => {
		const v = reconcileA11y(CASE, [], []);
		expect(v).toEqual({ unexpected: [], stale: [], tolerated: [] });
	});

	test("tolerates a listed rule on its page and reports the rest", () => {
		const listed = entry("color-contrast");
		const v = reconcileA11y(CASE, [violation("color-contrast"), violation("label")], [listed]);
		expect(v.unexpected.map((x) => x.rule)).toEqual(["label"]);
		expect(v.tolerated).toEqual([listed]);
		expect(v.stale).toEqual([]);
	});

	test("flags an entry whose violation stopped reproducing as stale", () => {
		const listed = entry("color-contrast");
		const v = reconcileA11y(CASE, [], [listed]);
		expect(v.stale).toEqual([listed]);
	});

	test("ignores entries for another page, viewport, or theme", () => {
		const others = [
			entry("label", { page: "events" }),
			entry("label", { viewport: "desktop" }),
			entry("label", { theme: "light" }),
		];
		const v = reconcileA11y(CASE, [violation("label")], others);
		expect(v.unexpected).toHaveLength(1);
		expect(v.stale).toEqual([]);
	});

	test("applies an entry narrowed to the case's own viewport and theme", () => {
		const listed = entry("label", { viewport: "phone", theme: "dark" });
		const v = reconcileA11y(CASE, [violation("label")], [listed]);
		expect(v.unexpected).toEqual([]);
		expect(v.tolerated).toEqual([listed]);
	});
});

describe("formatViolation", () => {
	test("lists rule, impact, help URL, and caps the selectors", () => {
		const targets = Array.from({ length: 10 }, (_, i) => `#n${i}`);
		const lines = formatViolation({ ...violation("color-contrast"), targets });
		expect(lines[0]).toBe("[color-contrast] serious: color-contrast help (10 nodes)");
		expect(lines[1]).toBe("    https://x");
		expect(lines).toContain("    #n7");
		expect(lines).not.toContain("    #n8");
		expect(lines.at(-1)).toBe("    … and 2 more");
	});
});

describe("formatA11yVerdict", () => {
	test("is empty for a passing verdict", () => {
		expect(formatA11yVerdict("runs.phone.dark", { unexpected: [], stale: [], tolerated: [] })).toBe(
			"",
		);
	});

	test("names the case, each violation, and each stale entry", () => {
		const msg = formatA11yVerdict("runs.phone.dark", {
			unexpected: [violation("label")],
			stale: [entry("color-contrast")],
			tolerated: [],
		});
		expect(msg.split("\n")[0]).toBe("runs.phone.dark");
		expect(msg).toContain("[label] serious: label help (1 node)");
		expect(msg).toContain(
			"[color-contrast] allowlisted violation (warren-23b5) no longer reproduces",
		);
	});
});

describe("parseAllowlist", () => {
	test("accepts a well-formed list and keeps optional narrowing", () => {
		const out = parseAllowlist({
			allowlist: [{ page: "runs", rule: "label", theme: "dark", seed: "warren-1234", reason: "r" }],
		});
		expect(out).toEqual([
			{ page: "runs", rule: "label", theme: "dark", seed: "warren-1234", reason: "r" },
		]);
	});

	test("rejects a missing array, a missing field, and a malformed seed", () => {
		expect(() => parseAllowlist({})).toThrow('"allowlist" must be an array');
		expect(() => parseAllowlist({ allowlist: [{ page: "runs", seed: "warren-1234" }] })).toThrow(
			'allowlist[0]: "rule" is required',
		);
		expect(() =>
			parseAllowlist({ allowlist: [{ page: "runs", rule: "label", seed: "later", reason: "r" }] }),
		).toThrow('"seed" must look like warren-XXXX');
	});
});

describe("a11y-allowlist.json", () => {
	const allowlist = loadAllowlist();

	test("only shrinks: the entry count stays at or under the ratchet ceiling", () => {
		expect(allowlist.length).toBeLessThanOrEqual(ALLOWLIST_CEILING);
	});

	test("every entry names a manifest page, a known viewport and theme, and is unique", () => {
		const pageIds = PAGES.map((p) => p.id);
		const seen = new Set<string>();
		for (const e of allowlist) {
			expect(pageIds).toContain(e.page);
			if (e.viewport !== undefined)
				expect(VIEWPORT_NAMES as readonly string[]).toContain(e.viewport);
			if (e.theme !== undefined) expect(THEMES as readonly string[]).toContain(e.theme);
			const key = `${e.page}|${e.rule}|${e.viewport ?? "*"}|${e.theme ?? "*"}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});
});
