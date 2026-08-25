import { describe, expect, test } from "bun:test";
import { canonicalJson, digestOf, isSha256Hex, sha256Hex } from "./digest.ts";

describe("canonicalJson", () => {
	test("sorts object keys recursively and emits no whitespace", () => {
		expect(canonicalJson({ b: 1, a: { d: true, c: [3, 1, 2] } })).toBe(
			'{"a":{"c":[3,1,2],"d":true},"b":1}',
		);
	});

	test("is insensitive to key order but sensitive to values", () => {
		expect(canonicalJson({ x: 1, y: "s" })).toBe(canonicalJson({ y: "s", x: 1 }));
		expect(canonicalJson({ x: 1 })).not.toBe(canonicalJson({ x: 2 }));
	});

	test("drops undefined-valued keys so optionals never disturb digests", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
	});

	test("rejects non-JSON values deterministically", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson(() => 1)).toThrow();
		expect(() => canonicalJson(new Date(0))).toThrow();
	});
});

describe("sha256Hex", () => {
	test("produces the pinned sha256 of the empty string", () => {
		expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	test("is stable and hex-shaped", () => {
		const d = sha256Hex("warren");
		expect(d).toBe(sha256Hex("warren"));
		expect(isSha256Hex(d)).toBe(true);
		expect(isSha256Hex("ABC")).toBe(false);
	});
});

describe("digestOf", () => {
	test("digests the canonical form, not the literal serialization", () => {
		expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
	});
});
