import { describe, expect, test } from "bun:test";
import {
	resolveWarrenBotIdentity,
	WARREN_BOT_IDENTITY,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "./bot-identity.ts";

describe("WARREN_BOT_IDENTITY", () => {
	test("pins the canonical default bot name and a non-routable RFC 2606 email", () => {
		expect(WARREN_BOT_IDENTITY.name).toBe("warren");
		expect(WARREN_BOT_IDENTITY.email).toBe("bot@warren.invalid");
	});
});

describe("resolveWarrenBotIdentity (warren-02cd)", () => {
	test("returns the default when no override env is set", () => {
		expect(resolveWarrenBotIdentity({})).toEqual(WARREN_BOT_IDENTITY);
	});

	test("returns the operator override when both halves are set", () => {
		const env = { WARREN_BOT_NAME: "warren-run-bot", WARREN_BOT_EMAIL: "bot@example.com" };
		expect(resolveWarrenBotIdentity(env)).toEqual({
			name: "warren-run-bot",
			email: "bot@example.com",
		});
	});

	test("ignores a half-set pair rather than half-applying it", () => {
		expect(resolveWarrenBotIdentity({ WARREN_BOT_NAME: "warren-run-bot" })).toEqual(
			WARREN_BOT_IDENTITY,
		);
		expect(resolveWarrenBotIdentity({ WARREN_BOT_EMAIL: "bot@example.com" })).toEqual(
			WARREN_BOT_IDENTITY,
		);
	});

	test("treats whitespace-only values as unset", () => {
		expect(
			resolveWarrenBotIdentity({ WARREN_BOT_NAME: "  ", WARREN_BOT_EMAIL: "b@e.com" }),
		).toEqual(WARREN_BOT_IDENTITY);
	});
});

describe("warrenCommitIdentityArgs", () => {
	test("emits -c user.name / -c user.email pairs from the default identity", () => {
		expect(warrenCommitIdentityArgs({})).toEqual([
			"-c",
			"user.name=warren",
			"-c",
			"user.email=bot@warren.invalid",
		]);
	});

	test("emits the operator override when configured", () => {
		const env = { WARREN_BOT_NAME: "warren-run-bot", WARREN_BOT_EMAIL: "bot@example.com" };
		expect(warrenCommitIdentityArgs(env)).toEqual([
			"-c",
			"user.name=warren-run-bot",
			"-c",
			"user.email=bot@example.com",
		]);
	});

	test("returns a fresh array each call so callers cannot share mutable state", () => {
		const a = warrenCommitIdentityArgs({});
		const b = warrenCommitIdentityArgs({});
		expect(a).not.toBe(b);
		a.push("mutated");
		expect(warrenCommitIdentityArgs({})).toHaveLength(4);
	});
});

describe("warrenCommitIdentityEnv (warren-035c)", () => {
	test("emits GIT_AUTHOR_*/GIT_COMMITTER_* from the default identity", () => {
		expect(warrenCommitIdentityEnv({})).toEqual({
			GIT_AUTHOR_NAME: "warren",
			GIT_AUTHOR_EMAIL: "bot@warren.invalid",
			GIT_COMMITTER_NAME: "warren",
			GIT_COMMITTER_EMAIL: "bot@warren.invalid",
		});
	});

	test("emits the operator override when configured", () => {
		const env = { WARREN_BOT_NAME: "warren-run-bot", WARREN_BOT_EMAIL: "bot@example.com" };
		expect(warrenCommitIdentityEnv(env)).toEqual({
			GIT_AUTHOR_NAME: "warren-run-bot",
			GIT_AUTHOR_EMAIL: "bot@example.com",
			GIT_COMMITTER_NAME: "warren-run-bot",
			GIT_COMMITTER_EMAIL: "bot@example.com",
		});
	});

	test("derives from the single resolver (no re-spelled literals)", () => {
		const env = warrenCommitIdentityEnv({});
		const identity = resolveWarrenBotIdentity({});
		expect(env.GIT_AUTHOR_NAME).toBe(identity.name);
		expect(env.GIT_AUTHOR_EMAIL).toBe(identity.email);
		expect(env.GIT_COMMITTER_NAME).toBe(identity.name);
		expect(env.GIT_COMMITTER_EMAIL).toBe(identity.email);
	});

	test("returns a fresh object each call so callers cannot share mutable state", () => {
		const a = warrenCommitIdentityEnv({});
		const b = warrenCommitIdentityEnv({});
		expect(a).not.toBe(b);
	});
});
