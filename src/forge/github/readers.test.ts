import { describe, expect, test } from "bun:test";
import { readAutoMergeState, readJson, readText, truncate } from "./readers.ts";

describe("readJson", () => {
	test("parses a JSON body", async () => {
		const res = new Response('{"a":1}', { status: 200 });
		expect(await readJson(res)).toEqual({ a: 1 });
	});

	test("returns null for a non-JSON body", async () => {
		const res = new Response("not json", { status: 200 });
		expect(await readJson(res)).toBeNull();
	});

	test("returns null when the body reader throws", async () => {
		const res = new Response("", { status: 200 });
		Object.defineProperty(res, "json", {
			value: () => Promise.reject(new Error("boom")),
		});
		expect(await readJson(res)).toBeNull();
	});
});

describe("readText", () => {
	test("reads a text body", async () => {
		const res = new Response("hello", { status: 200 });
		expect(await readText(res)).toBe("hello");
	});

	test("returns empty string when the body reader throws", async () => {
		const res = new Response("", { status: 200 });
		Object.defineProperty(res, "text", {
			value: () => Promise.reject(new Error("boom")),
		});
		expect(await readText(res)).toBe("");
	});
});

describe("readAutoMergeState", () => {
	test("maps a non-null auto_merge request onto armed (pl-92a3)", () => {
		expect(readAutoMergeState({ enabled: true, merge_method: "squash" })).toBe("armed");
	});

	test("maps a null or absent auto_merge onto unarmed", () => {
		expect(readAutoMergeState(null)).toBe("unarmed");
		expect(readAutoMergeState(undefined)).toBe("unarmed");
	});
});

describe("truncate", () => {
	test("returns short input unchanged", () => {
		expect(truncate("abc", 5)).toBe("abc");
		expect(truncate("abcde", 5)).toBe("abcde");
	});

	test("truncates long input with an ellipsis", () => {
		expect(truncate("abcdef", 5)).toBe("abcde…");
	});
});
