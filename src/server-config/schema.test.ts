import { describe, expect, test } from "bun:test";
import { parseWarrenServerFileConfig } from "./schema.ts";

describe("parseWarrenServerFileConfig", () => {
	test("undefined → empty config", () => {
		const result = parseWarrenServerFileConfig(undefined);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("null → empty config (defensive: TOML rarely produces null at root)", () => {
		const result = parseWarrenServerFileConfig(null);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("empty object → empty config", () => {
		const result = parseWarrenServerFileConfig({});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({});
	});

	test("unknown top-level key → not ok (strict schema rejects passthrough)", () => {
		const result = parseWarrenServerFileConfig({ banana: 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/banana/);
	});

	test("non-object root → not ok", () => {
		const result = parseWarrenServerFileConfig("not an object");
		expect(result.ok).toBe(false);
	});

	test("[[workers]] block → not ok (retired with the K8s migration, warren-288f)", () => {
		const result = parseWarrenServerFileConfig({
			workers: [{ name: "alpha", url: "http://alpha:9410" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/workers/);
	});
});
