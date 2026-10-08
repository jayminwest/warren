import { describe, expect, test } from "bun:test";

import { PAGES, type PageSpec } from "./pages.ts";
import {
	evaluateSmoke,
	findLeakedText,
	formatVerdict,
	KNOWN_FAILURES,
	type KnownFailure,
	type PageObservation,
	reconcile,
	SMOKE_CHECKS,
} from "./smoke-checks.ts";

const CLEAN: PageObservation = {
	consoleErrors: [],
	scrollers: [
		{ selector: "html", scrollWidth: 393, clientWidth: 393 },
		{ selector: "main", scrollWidth: 393, clientWidth: 393 },
	],
	rootChildCount: 1,
	bodyText: "Runs\n6 runs · 2 active",
};

const RUNS: PageSpec = { id: "runs", route: "/runs", path: () => "/runs" };
const CASE = { page: RUNS, viewport: "phone", theme: "dark" } as const;

describe("findLeakedText", () => {
	test("finds each leak token with an excerpt", () => {
		const hits = findLeakedText("cost $NaN · model undefined · meta [object Object]");
		expect(hits).toHaveLength(3);
		expect(hits[0]).toContain('"undefined"');
		expect(hits[1]).toContain('"NaN" in "…cost $NaN');
		expect(hits[2]).toContain('"[object Object]"');
	});

	test("ignores the tokens inside longer words and other casings", () => {
		expect(findLeakedText("Finance · nan · undefinedness · Undefined")).toEqual([]);
	});
});

describe("evaluateSmoke", () => {
	test("passes a clean page", () => {
		expect(evaluateSmoke(CLEAN)).toEqual([]);
	});

	test("reports one problem per console error, plus overflow, empty root, and leaks", () => {
		const problems = evaluateSmoke({
			consoleErrors: ["pageerror: boom", "console.error: nope"],
			scrollers: [
				{ selector: "html", scrollWidth: 393, clientWidth: 393 },
				{ selector: "main", scrollWidth: 420, clientWidth: 393 },
			],
			rootChildCount: 0,
			bodyText: "NaN runs",
		});
		expect(problems.map((p) => p.check)).toEqual([
			"console",
			"console",
			"overflow",
			"root",
			"text",
		]);
		expect(problems[2]?.detail).toBe(
			"horizontal overflow in main: scrollWidth 420 > clientWidth 393 (+27px)",
		);
	});

	test("treats a page exactly as wide as the viewport, or narrower, as no overflow", () => {
		const scrollers = [{ selector: "html", scrollWidth: 300, clientWidth: 393 }];
		expect(evaluateSmoke({ ...CLEAN, scrollers })).toEqual([]);
	});

	test("reports overflow in the document and in main separately", () => {
		const scrollers = [
			{ selector: "html", scrollWidth: 400, clientWidth: 393 },
			{ selector: "main", scrollWidth: 500, clientWidth: 393 },
		];
		const details = evaluateSmoke({ ...CLEAN, scrollers }).map((p) => p.detail);
		expect(details).toHaveLength(2);
		expect(details[0]).toContain("in html");
		expect(details[1]).toContain("(+107px)");
	});
});

describe("reconcile", () => {
	const known = (over: Partial<KnownFailure>): KnownFailure => ({
		page: "runs",
		check: "console",
		seed: "warren-0000",
		reason: "test",
		...over,
	});

	test("flags problems no known failure covers", () => {
		const v = reconcile(CASE, [{ check: "overflow", detail: "x" }], []);
		expect(v.unexpected).toEqual([{ check: "overflow", detail: "x" }]);
		expect(v.stale).toEqual([]);
	});

	test("tolerates only the problems a match pattern covers", () => {
		const k = known({ match: /401/ });
		const v = reconcile(
			CASE,
			[
				{ check: "console", detail: "status of 401" },
				{ check: "console", detail: "pageerror: boom" },
			],
			[k],
		);
		expect(v.tolerated).toEqual([k]);
		expect(v.unexpected).toEqual([{ check: "console", detail: "pageerror: boom" }]);
	});

	test("reports a known failure that no longer reproduces as stale", () => {
		const k = known({});
		const v = reconcile(CASE, [], [k]);
		expect(v.stale).toEqual([k]);
		expect(formatVerdict("runs.phone.dark", v)).toContain("no longer reproduces");
	});

	test("scopes a known failure to its viewport and theme", () => {
		const k = known({ viewport: "desktop" });
		const v = reconcile(CASE, [{ check: "console", detail: "x" }], [k]);
		expect(v.unexpected).toHaveLength(1);
		expect(v.stale).toEqual([]);
	});

	test("formats an empty message for a passing case", () => {
		expect(formatVerdict("runs.phone.dark", reconcile(CASE, [], []))).toBe("");
	});

	test("formats one line per unexpected problem under the case name", () => {
		const v = reconcile(CASE, [{ check: "root", detail: "#root rendered no children" }], []);
		expect(formatVerdict("runs.phone.dark", v)).toBe(
			"runs.phone.dark\n[root] #root rendered no children",
		);
	});
});

describe("KNOWN_FAILURES", () => {
	test("names a manifest page, a smoke check, and a reason on every entry", () => {
		const ids = new Set(PAGES.map((p) => p.id));
		for (const k of KNOWN_FAILURES) {
			expect(ids.has(k.page)).toBe(true);
			expect(SMOKE_CHECKS).toContain(k.check);
			expect(k.reason.length).toBeGreaterThan(0);
			expect(k.seed).toMatch(/^warren-[0-9a-f]{4}$/);
		}
	});

	test("tolerates the login page's anonymous 401 probes and nothing else there", () => {
		const login = PAGES.find((p) => p.id === "login");
		if (login === undefined) throw new Error("login missing from PAGES");
		const c = { page: login, viewport: "phone", theme: "light" } as const;
		const v = reconcile(c, [
			{
				check: "console",
				detail:
					"console.error: Failed to load resource: the server responded with a status of 401 (Unauthorized) (http://127.0.0.1:4517/whoami:0)",
			},
			{ check: "console", detail: "pageerror: boom" },
		]);
		expect(v.tolerated).toHaveLength(1);
		expect(v.unexpected).toEqual([{ check: "console", detail: "pageerror: boom" }]);
	});
});
