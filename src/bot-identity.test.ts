import { describe, expect, test } from "bun:test";
import {
	WARREN_BOT_IDENTITY,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "./bot-identity.ts";

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

describe("warrenCommitIdentityEnv (warren-035c)", () => {
	test("emits GIT_AUTHOR_*/GIT_COMMITTER_* from the canonical identity", () => {
		expect(warrenCommitIdentityEnv()).toEqual({
			GIT_AUTHOR_NAME: "warren",
			GIT_AUTHOR_EMAIL: "warren@os-eco.dev",
			GIT_COMMITTER_NAME: "warren",
			GIT_COMMITTER_EMAIL: "warren@os-eco.dev",
		});
	});

	test("derives from the single WARREN_BOT_IDENTITY source (no re-spelled literals)", () => {
		const env = warrenCommitIdentityEnv();
		expect(env.GIT_AUTHOR_NAME).toBe(WARREN_BOT_IDENTITY.name);
		expect(env.GIT_AUTHOR_EMAIL).toBe(WARREN_BOT_IDENTITY.email);
		expect(env.GIT_COMMITTER_NAME).toBe(WARREN_BOT_IDENTITY.name);
		expect(env.GIT_COMMITTER_EMAIL).toBe(WARREN_BOT_IDENTITY.email);
	});

	test("returns a fresh object each call so callers cannot share mutable state", () => {
		const a = warrenCommitIdentityEnv();
		const b = warrenCommitIdentityEnv();
		expect(a).not.toBe(b);
	});
});
