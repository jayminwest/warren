import { describe, expect, test } from "bun:test";
import { ANONYMOUS_ACTOR, OPERATOR_ACTOR } from "./auth.ts";
import { isPublicOnly, pickFields } from "./projection.ts";

/**
 * Unit coverage for the public-projection primitives (warren-946f).
 * The per-endpoint field lists are asserted next to their handlers; this
 * file only pins the mechanism they all share.
 */

describe("isPublicOnly", () => {
	test("an operator reads the full body", () => {
		expect(isPublicOnly(OPERATOR_ACTOR)).toBe(false);
	});

	test("a readPublic-only spectator gets the projection", () => {
		expect(isPublicOnly(ANONYMOUS_ACTOR)).toBe(true);
	});

	test("an absent actor is treated as the operator", () => {
		// Auth-exempt paths and hand-built test contexts never run the gate;
		// preserving the pre-public-mode behavior there is deliberate.
		expect(isPublicOnly(undefined)).toBe(false);
	});
});

describe("pickFields", () => {
	test("copies exactly the named keys", () => {
		const source = { a: 1, b: "two", c: null };
		expect(pickFields(source, ["a", "c"])).toEqual({ a: 1, c: null });
	});

	test("emits no key that was not named, even for a later-added field", () => {
		const source = { a: 1, addedTomorrow: "secret" };
		expect(Object.keys(pickFields(source, ["a"]))).toEqual(["a"]);
	});

	test("preserves an explicitly-named undefined value as a present key", () => {
		const source: { a: number | undefined } = { a: undefined };
		expect(Object.hasOwn(pickFields(source, ["a"]), "a")).toBe(true);
	});
});
