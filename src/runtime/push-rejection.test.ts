import { describe, expect, test } from "bun:test";

import { parsePushRejection } from "./push-rejection.ts";

/**
 * The shape GitHub prints when secret-scanning push protection refuses a push,
 * reproduced from run_m6br4vntg007 (warren-b68d). No fixture here carries a
 * credential-shaped literal: the secret's TYPE is a label GitHub prints, and
 * the unblock URL is an opaque id, so this file cannot flag its own push.
 */
const PUSH_PROTECTION = [
	"remote: error: GH013: Repository rule violations found for refs/heads/warren/run-abc.",
	"remote: ",
	"remote: - GITHUB PUSH PROTECTION",
	"remote:   —————————————————————————————————————————",
	"remote:     Resolve the following violations before pushing again",
	"remote: ",
	"remote:     - Push cannot contain secrets",
	"remote: ",
	"remote:       —— Linear API Key ——————————————————————",
	"remote:        locations:",
	"remote:          - commit: 4f21c0d8b1a54e0f9c3d2b7a6e5f4c3d2b1a0f9e",
	"remote:            path: src/redaction/scrub.test.ts:42",
	"remote: ",
	"remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.",
	"remote:        https://github.com/jayminwest/warren/security/secret-scanning/unblock-secret/2xYzAbC/",
	"remote: ",
	"To https://github.com/jayminwest/warren.git",
	" ! [remote rejected] HEAD -> warren/run-abc (push declined due to repository rule violations)",
	"error: failed to push some refs to 'https://github.com/jayminwest/warren.git'",
].join("\n");

const NON_FAST_FORWARD = [
	"To https://github.com/jayminwest/warren.git",
	" ! [rejected]        HEAD -> warren/run-abc (non-fast-forward)",
	"error: failed to push some refs to 'https://github.com/jayminwest/warren.git'",
	"hint: Updates were rejected because the tip of your current branch is behind",
	"hint: its remote counterpart. Integrate the remote changes before pushing again.",
].join("\n");

const PROTECTED_BRANCH = [
	"remote: error: GH006: Protected branch update failed for refs/heads/main.",
	"remote: error: At least 1 approving review is required by reviewers with write access.",
	"To https://github.com/jayminwest/warren.git",
	" ! [remote rejected] HEAD -> main (protected branch hook declined)",
].join("\n");

describe("parsePushRejection", () => {
	test("reads the unblock URL and the flagged path out of a push-protection refusal", () => {
		const rejection = parsePushRejection(PUSH_PROTECTION);

		expect(rejection).not.toBeNull();
		expect(rejection?.unblockUrls).toEqual([
			"https://github.com/jayminwest/warren/security/secret-scanning/unblock-secret/2xYzAbC/",
		]);
		expect(rejection?.locations).toEqual(["src/redaction/scrub.test.ts:42"]);
	});

	test("a non-fast-forward is NOT a policy rejection", () => {
		// The distinction the failure reason exists to draw: this one is warren's
		// to fix by rebasing, and stays `finalize_failed`.
		expect(parsePushRejection(NON_FAST_FORWARD)).toBeNull();
	});

	test("a protected-branch refusal is a policy rejection with nothing to unblock", () => {
		const rejection = parsePushRejection(PROTECTED_BRANCH);

		expect(rejection).not.toBeNull();
		expect(rejection?.unblockUrls).toEqual([]);
		expect(rejection?.locations).toEqual([]);
	});

	test("collects every secret's URL and path when a push trips more than one rule", () => {
		const twoSecrets = [
			"remote: error: GH013: Repository rule violations found for refs/heads/warren/run-abc.",
			"remote: - GITHUB PUSH PROTECTION",
			"remote:       —— Linear API Key ——",
			"remote:        locations:",
			"remote:          - commit: 4f21c0d8",
			"remote:            path: src/redaction/scrub.test.ts:42",
			"remote:        https://github.com/o/r/security/secret-scanning/unblock-secret/aaa/",
			"remote:       —— Stripe API Key ——",
			"remote:        locations:",
			"remote:          - commit: 4f21c0d8",
			"remote:            path: src/redaction/fixtures.ts:7",
			"remote:        https://github.com/o/r/security/secret-scanning/unblock-secret/bbb/",
		].join("\n");

		const rejection = parsePushRejection(twoSecrets);

		expect(rejection?.unblockUrls).toEqual([
			"https://github.com/o/r/security/secret-scanning/unblock-secret/aaa/",
			"https://github.com/o/r/security/secret-scanning/unblock-secret/bbb/",
		]);
		expect(rejection?.locations).toEqual([
			"src/redaction/scrub.test.ts:42",
			"src/redaction/fixtures.ts:7",
		]);
	});

	test("reports one finding when two rules flag the same file", () => {
		const repeated = [
			"remote: error: GH013: Repository rule violations found for refs/heads/warren/run-abc.",
			"remote: - GITHUB PUSH PROTECTION",
			"remote:            path: src/redaction/scrub.test.ts:42",
			"remote:        https://github.com/o/r/security/secret-scanning/unblock-secret/aaa/",
			"remote:            path: src/redaction/scrub.test.ts:42",
			"remote:        https://github.com/o/r/security/secret-scanning/unblock-secret/aaa/",
		].join("\n");

		expect(parsePushRejection(repeated)?.locations).toEqual(["src/redaction/scrub.test.ts:42"]);
		expect(parsePushRejection(repeated)?.unblockUrls).toEqual([
			"https://github.com/o/r/security/secret-scanning/unblock-secret/aaa/",
		]);
	});

	test("keeps the trailing slash but drops sentence punctuation after the URL", () => {
		const punctuated = [
			"remote: error: GH013: Repository rule violations found for refs/heads/warren/run-abc.",
			"remote: follow this URL to allow the secret:",
			"remote: https://github.com/o/r/security/secret-scanning/unblock-secret/ccc/.",
		].join("\n");

		expect(parsePushRejection(punctuated)?.unblockUrls).toEqual([
			"https://github.com/o/r/security/secret-scanning/unblock-secret/ccc/",
		]);
	});

	test("an auth failure and an empty output are not policy rejections", () => {
		expect(parsePushRejection("remote: Invalid username or password.")).toBeNull();
		expect(parsePushRejection("fatal: Authentication failed")).toBeNull();
		expect(parsePushRejection("")).toBeNull();
		expect(parsePushRejection("   \n  \n")).toBeNull();
	});

	test("reads the local runner's Error message, which carries stderr verbatim", () => {
		// `ReapExec.run` rejects with an Error whose message is the stderr, so the
		// LocalProvider path parses a message rather than a captured stream.
		const err = new Error(PUSH_PROTECTION);

		expect(parsePushRejection(err.message)?.locations).toEqual(["src/redaction/scrub.test.ts:42"]);
	});
});
