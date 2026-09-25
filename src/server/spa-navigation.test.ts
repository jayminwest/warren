import { describe, expect, test } from "bun:test";
import { isSpaDeepLink } from "./spa-navigation.ts";

function req(headers: Record<string, string>, method = "GET"): Request {
	return new Request("http://warren.test/x", { method, headers });
}

describe("isSpaDeepLink", () => {
	test("accepts a document navigation to a colliding UI route", () => {
		const nav = req({ "sec-fetch-mode": "navigate" });
		for (const path of ["/runs", "/runs/run_1", "/projects/", "/agents", "/events", "/instance"]) {
			expect(isSpaDeepLink(nav, path)).toBe(true);
		}
	});

	test("falls back to the Accept header when fetch metadata is absent", () => {
		expect(isSpaDeepLink(req({ accept: "text/html,*/*" }), "/runs")).toBe(true);
		expect(isSpaDeepLink(req({ accept: "application/json" }), "/runs")).toBe(false);
		expect(isSpaDeepLink(req({}), "/runs")).toBe(false);
	});

	test("rejects fetches, non-GETs, and API-only shapes", () => {
		expect(isSpaDeepLink(req({ "sec-fetch-mode": "cors", accept: "text/html" }), "/runs")).toBe(
			false,
		);
		expect(isSpaDeepLink(req({ "sec-fetch-mode": "navigate" }, "POST"), "/runs")).toBe(false);
		const nav = req({ "sec-fetch-mode": "navigate" });
		for (const path of ["/runs/run_1/events", "/setup", "/extensions/judge/verdicts.jsonl"]) {
			expect(isSpaDeepLink(nav, path)).toBe(false);
		}
	});
});
