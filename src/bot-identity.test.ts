import { describe, expect, test } from "bun:test";
import { WARREN_BOT_IDENTITY, warrenCommitIdentityArgs } from "./bot-identity.ts";

describe("WARREN_BOT_IDENTITY", () => {
	test("pins the canonical warren bot name and email", () => {
		expect(WARREN_BOT_IDENTITY.name).toBe("warren");
		expect(WARREN_BOT_IDENTITY.email).toBe("warren@os-eco.dev");
	});
});

describe("warrenCommitIdentityArgs", () => {
	test("emits -c user.name / -c user.email pairs from the canonical identity", () => {
		expect(warrenCommitIdentityArgs()).toEqual([
			"-c",
			"user.name=warren",
			"-c",
			"user.email=warren@os-eco.dev",
		]);
	});

	test("returns a fresh array each call so callers cannot share mutable state", () => {
		const a = warrenCommitIdentityArgs();
		const b = warrenCommitIdentityArgs();
		expect(a).not.toBe(b);
		a.push("mutated");
		expect(warrenCommitIdentityArgs()).toHaveLength(4);
	});
});
