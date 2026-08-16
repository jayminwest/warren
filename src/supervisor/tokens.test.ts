import { describe, expect, test } from "bun:test";
import {
	ensureBurrowAuthTokens,
	mintSharedBurrowToken,
	TokenValidationError,
	tokenFingerprint,
	validateBurrowAuthTokens,
} from "./tokens.ts";

describe("validateBurrowAuthTokens", () => {
	test("noAuth=true skips validation and returns null fingerprint", () => {
		const result = validateBurrowAuthTokens({
			burrowApiToken: undefined,
			warrenBurrowToken: undefined,
			noAuth: true,
		});
		expect(result.fingerprint).toBeNull();
	});

	test("noAuth=true skips even when one token is mismatched (loopback dev escape hatch)", () => {
		const result = validateBurrowAuthTokens({
			burrowApiToken: "a",
			warrenBurrowToken: "b",
			noAuth: true,
		});
		expect(result.fingerprint).toBeNull();
	});

	test("missing both tokens throws TokenValidationError naming both vars", () => {
		expect(() =>
			validateBurrowAuthTokens({
				burrowApiToken: undefined,
				warrenBurrowToken: undefined,
				noAuth: false,
			}),
		).toThrow(TokenValidationError);
		try {
			validateBurrowAuthTokens({
				burrowApiToken: undefined,
				warrenBurrowToken: undefined,
				noAuth: false,
			});
		} catch (err) {
			const e = err as TokenValidationError;
			expect(e.message).toContain("BURROW_API_TOKEN");
			expect(e.message).toContain("WARREN_BURROW_TOKEN");
			expect(e.recoveryHint).toContain("openssl rand");
			expect(e.recoveryHint).toContain("WARREN_BURROW_NO_AUTH");
		}
	});

	test("treats empty string the same as undefined", () => {
		expect(() =>
			validateBurrowAuthTokens({
				burrowApiToken: "",
				warrenBurrowToken: "",
				noAuth: false,
			}),
		).toThrow(/BURROW_API_TOKEN and WARREN_BURROW_TOKEN are not set/);
	});

	test("only WARREN_BURROW_TOKEN set throws naming BURROW_API_TOKEN as the missing one", () => {
		try {
			validateBurrowAuthTokens({
				burrowApiToken: undefined,
				warrenBurrowToken: "tok",
				noAuth: false,
			});
			throw new Error("expected throw");
		} catch (err) {
			const e = err as TokenValidationError;
			expect(e).toBeInstanceOf(TokenValidationError);
			expect(e.message).toContain("BURROW_API_TOKEN is not set");
			expect(e.recoveryHint).toContain("'burrow serve'");
		}
	});

	test("only BURROW_API_TOKEN set throws naming WARREN_BURROW_TOKEN as the missing one", () => {
		try {
			validateBurrowAuthTokens({
				burrowApiToken: "tok",
				warrenBurrowToken: undefined,
				noAuth: false,
			});
			throw new Error("expected throw");
		} catch (err) {
			const e = err as TokenValidationError;
			expect(e).toBeInstanceOf(TokenValidationError);
			expect(e.message).toContain("WARREN_BURROW_TOKEN is not set");
			expect(e.recoveryHint).toContain("burrow-client");
		}
	});

	test("mismatched tokens throw with a single shared-secret hint", () => {
		try {
			validateBurrowAuthTokens({
				burrowApiToken: "alpha",
				warrenBurrowToken: "beta",
				noAuth: false,
			});
			throw new Error("expected throw");
		} catch (err) {
			const e = err as TokenValidationError;
			expect(e).toBeInstanceOf(TokenValidationError);
			expect(e.message).toContain("do not match");
			expect(e.recoveryHint).toContain("openssl rand");
		}
	});

	test("matched tokens return a sha256:<12-hex> fingerprint", () => {
		const result = validateBurrowAuthTokens({
			burrowApiToken: "shared-secret",
			warrenBurrowToken: "shared-secret",
			noAuth: false,
		});
		expect(result.fingerprint).not.toBeNull();
		expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
	});

	test("error messages and recovery hints never leak the token value", () => {
		const cases: { burrow: string | undefined; warren: string | undefined }[] = [
			{ burrow: undefined, warren: undefined },
			{ burrow: undefined, warren: "warren-only-secret" },
			{ burrow: "burrow-only-secret", warren: undefined },
			{ burrow: "burrow-side-secret", warren: "warren-side-secret" },
		];
		for (const { burrow, warren } of cases) {
			try {
				validateBurrowAuthTokens({
					burrowApiToken: burrow,
					warrenBurrowToken: warren,
					noAuth: false,
				});
				throw new Error("expected throw");
			} catch (err) {
				const e = err as TokenValidationError;
				const blob = `${e.message}\n${e.recoveryHint}`;
				if (burrow !== undefined) expect(blob).not.toContain(burrow);
				if (warren !== undefined) expect(blob).not.toContain(warren);
			}
		}
	});

	test("matched-token fingerprint is identical for identical inputs and differs across inputs", () => {
		const a = validateBurrowAuthTokens({
			burrowApiToken: "secret-A",
			warrenBurrowToken: "secret-A",
			noAuth: false,
		});
		const a2 = validateBurrowAuthTokens({
			burrowApiToken: "secret-A",
			warrenBurrowToken: "secret-A",
			noAuth: false,
		});
		const b = validateBurrowAuthTokens({
			burrowApiToken: "secret-B",
			warrenBurrowToken: "secret-B",
			noAuth: false,
		});
		expect(a.fingerprint).toBe(a2.fingerprint);
		expect(a.fingerprint).not.toBe(b.fingerprint);
	});
});

describe("tokenFingerprint", () => {
	test("returns sha256:<12-hex> and is deterministic", () => {
		const fp = tokenFingerprint("hello");
		expect(fp).toMatch(/^sha256:[0-9a-f]{12}$/);
		expect(tokenFingerprint("hello")).toBe(fp);
	});

	test("never includes the token in the output", () => {
		const fp = tokenFingerprint("super-secret-value");
		expect(fp).not.toContain("super-secret-value");
	});
});

describe("mintSharedBurrowToken", () => {
	test("returns 64 lowercase hex chars (256 bits)", () => {
		expect(mintSharedBurrowToken()).toMatch(/^[0-9a-f]{64}$/);
	});

	test("generates a distinct token on every call", () => {
		const seen = new Set(Array.from({ length: 100 }, () => mintSharedBurrowToken()));
		expect(seen.size).toBe(100);
	});
});

describe("ensureBurrowAuthTokens", () => {
	test("mints one token into both vars when neither is set", () => {
		const env: Record<string, string | undefined> = {};
		const result = ensureBurrowAuthTokens(env, { noAuth: false });
		expect(result.minted).toBe(true);
		expect(env.BURROW_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(env.WARREN_BURROW_TOKEN).toBe(env.BURROW_API_TOKEN);
		expect(result.fingerprint).toBe(tokenFingerprint(env.BURROW_API_TOKEN ?? ""));
	});

	test("treats empty strings the same as unset and mints", () => {
		const env: Record<string, string | undefined> = {
			BURROW_API_TOKEN: "",
			WARREN_BURROW_TOKEN: "",
		};
		const result = ensureBurrowAuthTokens(env, { noAuth: false });
		expect(result.minted).toBe(true);
		expect(env.BURROW_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
	});

	test("keeps operator-supplied values when both are set and matching", () => {
		const env: Record<string, string | undefined> = {
			BURROW_API_TOKEN: "operator-secret",
			WARREN_BURROW_TOKEN: "operator-secret",
		};
		const result = ensureBurrowAuthTokens(env, { noAuth: false });
		expect(result.minted).toBe(false);
		expect(env.BURROW_API_TOKEN).toBe("operator-secret");
		expect(env.WARREN_BURROW_TOKEN).toBe("operator-secret");
		expect(result.fingerprint).toBe(tokenFingerprint("operator-secret"));
	});

	test("still fails fast when only one var is set (no silent mint)", () => {
		const env: Record<string, string | undefined> = { WARREN_BURROW_TOKEN: "tok" };
		expect(() => ensureBurrowAuthTokens(env, { noAuth: false })).toThrow(TokenValidationError);
		expect(env.BURROW_API_TOKEN).toBeUndefined();
	});

	test("still fails fast when the two operator values disagree", () => {
		const env: Record<string, string | undefined> = {
			BURROW_API_TOKEN: "a",
			WARREN_BURROW_TOKEN: "b",
		};
		expect(() => ensureBurrowAuthTokens(env, { noAuth: false })).toThrow(/do not match/);
	});

	test("noAuth skips minting and returns null fingerprint", () => {
		const env: Record<string, string | undefined> = {};
		const result = ensureBurrowAuthTokens(env, { noAuth: true });
		expect(result.minted).toBe(false);
		expect(result.fingerprint).toBeNull();
		expect(env.BURROW_API_TOKEN).toBeUndefined();
		expect(env.WARREN_BURROW_TOKEN).toBeUndefined();
	});

	test("uses the injected mint function", () => {
		const env: Record<string, string | undefined> = {};
		const result = ensureBurrowAuthTokens(env, { noAuth: false }, () => "minted-fixed");
		expect(result.minted).toBe(true);
		expect(env.BURROW_API_TOKEN).toBe("minted-fixed");
		expect(env.WARREN_BURROW_TOKEN).toBe("minted-fixed");
	});
});
