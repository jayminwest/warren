import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import { createHmacRunTokenMinter } from "../runs/spawn/run-token.ts";
import {
	ANONYMOUS_ACTOR,
	bearerAuth,
	DEFAULT_AUTH_KIND,
	NO_AUTH,
	OPERATOR_ACTOR,
	OPERATOR_TOKEN_FILE,
	policyAllows,
	publicReadAuth,
	resolveAuth,
	resolveAuthKind,
	resolveOperatorToken,
	runScopedAuth,
	UnknownAuthProviderError,
} from "./auth.ts";

function req(authorization?: string): Request {
	const headers: Record<string, string> = {};
	if (authorization !== undefined) headers.authorization = authorization;
	return new Request("http://localhost/test", { headers });
}

describe("NO_AUTH", () => {
	test("allows every request, including unauthenticated ones", () => {
		expect(NO_AUTH.authorize(req()).ok).toBe(true);
		expect(NO_AUTH.authorize(req("Bearer anything")).ok).toBe(true);
	});
});

describe("bearerAuth", () => {
	test("rejects missing header with 401 + WWW-Authenticate", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.code).toBe("unauthorized");
		expect(result.challenge).toContain('Bearer realm="warren"');
	});

	test("rejects malformed Authorization header", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Basic abc"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.challenge).toContain("invalid_request");
	});

	test("rejects an invalid token", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Bearer wrong"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.challenge).toContain("invalid_token");
	});

	test("accepts the matching token (case-insensitive scheme)", () => {
		const provider = bearerAuth("s3cret");
		expect(provider.authorize(req("Bearer s3cret")).ok).toBe(true);
		expect(provider.authorize(req("bearer s3cret")).ok).toBe(true);
	});

	test("rejects a same-prefix token of different length", () => {
		const provider = bearerAuth("secret");
		const result = provider.authorize(req("Bearer secretX"));
		expect(result.ok).toBe(false);
	});

	test("throws on construction with empty token", () => {
		expect(() => bearerAuth("")).toThrow();
	});
});

describe("actor (warren-1ff0)", () => {
	test("NO_AUTH authorizes the full-capability operator actor", () => {
		const result = NO_AUTH.authorize(req());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor).toEqual(OPERATOR_ACTOR);
	});

	test("bearerAuth authorizes the same actor a valid token has always got", () => {
		const result = bearerAuth("s3cret").authorize(req("Bearer s3cret"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor).toEqual(OPERATOR_ACTOR);
	});

	test("the operator actor holds every capability", () => {
		expect(OPERATOR_ACTOR.kind).toBe("operator");
		expect(OPERATOR_ACTOR.capabilities).toEqual({
			readPublic: true,
			readOperator: true,
			dispatch: true,
			admin: true,
		});
	});
});

describe("resolveAuth", () => {
	test("noAuth wins over everything else", () => {
		const provider = resolveAuth({
			noAuth: true,
			token: "ignored",
			env: { WARREN_API_TOKEN: "x" },
		});
		expect(provider).toBe(NO_AUTH);
	});

	test("explicit token wins over env", () => {
		const provider = resolveAuth({ token: "explicit", env: { WARREN_API_TOKEN: "fromenv" } });
		const ok = provider.authorize(req("Bearer explicit"));
		expect(ok.ok).toBe(true);
		const bad = provider.authorize(req("Bearer fromenv"));
		expect(bad.ok).toBe(false);
	});

	test("falls back to env.WARREN_API_TOKEN", () => {
		const provider = resolveAuth({ env: { WARREN_API_TOKEN: "fromenv" } });
		expect(provider.authorize(req("Bearer fromenv")).ok).toBe(true);
	});

	test("throws ValidationError when token is missing and noAuth is not set", () => {
		expect(() => resolveAuth({ env: {} })).toThrow(ValidationError);
	});

	test("throws ValidationError on empty token", () => {
		expect(() => resolveAuth({ env: { WARREN_API_TOKEN: "" } })).toThrow(ValidationError);
	});
});

describe("resolveOperatorToken (warren-ef6e)", () => {
	const freshDataDir = (): string => mkdtempSync(join(tmpdir(), "warren-token-boot-"));

	test("explicit WARREN_API_TOKEN always wins and never touches the data dir", () => {
		const dir = freshDataDir();
		writeFileSync(join(dir, OPERATOR_TOKEN_FILE), "persisted\n");
		const result = resolveOperatorToken({ WARREN_API_TOKEN: "explicit" }, dir);
		expect(result).toEqual({ token: "explicit", source: "env" });
		expect(readFileSync(join(dir, OPERATOR_TOKEN_FILE), "utf8")).toBe("persisted\n");
	});

	test("mints a base64url token and persists it 0600 when nothing is set", () => {
		const dir = freshDataDir();
		const result = resolveOperatorToken({}, join(dir, "nested"));
		expect(result.source).toBe("minted");
		expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		if (result.path === undefined) throw new Error("expected a persisted path");
		expect(readFileSync(result.path, "utf8")).toBe(`${result.token}\n`);
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
	});

	test("reuses the persisted token on the next boot without re-minting", () => {
		const dir = freshDataDir();
		const first = resolveOperatorToken({}, dir);
		const second = resolveOperatorToken({}, dir);
		expect(first.source).toBe("minted");
		expect(second.source).toBe("file");
		expect(second.token).toBe(first.token);
		expect(second.path).toBe(first.path);
	});

	test("treats an empty WARREN_API_TOKEN as unset", () => {
		const dir = freshDataDir();
		const result = resolveOperatorToken({ WARREN_API_TOKEN: "" }, dir);
		expect(result.source).toBe("minted");
	});

	test("renormalizes a loosely-permissioned persisted token to 0600", () => {
		const dir = freshDataDir();
		const path = join(dir, OPERATOR_TOKEN_FILE);
		writeFileSync(path, "persisted\n", { mode: 0o644 });
		const result = resolveOperatorToken({}, dir);
		expect(result).toEqual({ token: "persisted", source: "file", path });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("mints over an empty persisted file instead of booting with an empty token", () => {
		const dir = freshDataDir();
		const path = join(dir, OPERATOR_TOKEN_FILE);
		writeFileSync(path, "  \n");
		const result = resolveOperatorToken({}, dir);
		expect(result.source).toBe("minted");
		expect(result.token).not.toBe("");
		expect(readFileSync(path, "utf8")).toBe(`${result.token}\n`);
	});

	test("throws a ValidationError when the persisted token is unreadable", () => {
		// A dataDir that is a regular FILE makes the token path unreadable (ENOTDIR).
		const dir = freshDataDir();
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x");
		expect(() => resolveOperatorToken({}, file)).toThrow(ValidationError);
	});
});

describe("runScopedAuth (warren-57fd)", () => {
	const SECRET = "tok_operator_secret";
	const RUN_ID = "run_abc123def456";
	const provider = runScopedAuth(bearerAuth(SECRET), SECRET);
	const scopedToken = createHmacRunTokenMinter(SECRET).mint(RUN_ID);

	test("admits a valid run-scoped token as a run actor bound to its run", () => {
		const result = provider.authorize(req(`Bearer ${scopedToken}`));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor.kind).toBe("run");
		expect(result.actor.runId).toBe(RUN_ID);
	});

	test("the run actor lacks readPublic and admin", () => {
		const result = provider.authorize(req(`Bearer ${scopedToken}`));
		if (!result.ok) return;
		expect(result.actor.capabilities.readPublic).toBe(false);
		expect(result.actor.capabilities.admin).toBe(false);
	});

	test("401s a run-shaped token with a bad signature (does not fall through to operator)", () => {
		const forged = `wrs1.${RUN_ID}.deadbeef`;
		const result = provider.authorize(req(`Bearer ${forged}`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
	});

	test("delegates a plain operator bearer to the inner provider", () => {
		expect(provider.authorize(req(`Bearer ${SECRET}`)).ok).toBe(true);
		const operatorResult = provider.authorize(req(`Bearer ${SECRET}`));
		if (!operatorResult.ok) return;
		expect(operatorResult.actor.kind).toBe("operator");
	});

	test("resolveAuth wraps the operator provider so scoped tokens are admitted", () => {
		const resolved = resolveAuth({ token: SECRET, env: {} });
		const result = resolved.authorize(req(`Bearer ${scopedToken}`));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor.kind).toBe("run");
	});
});

describe("publicReadAuth (warren-851b)", () => {
	const provider = publicReadAuth(bearerAuth("s3cret"));

	test("admits a credential-less caller as the anonymous actor", () => {
		const result = provider.authorize(req());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor).toEqual(ANONYMOUS_ACTOR);
	});

	test("the anonymous actor holds readPublic and nothing else", () => {
		expect(ANONYMOUS_ACTOR.kind).toBe("anonymous");
		expect(ANONYMOUS_ACTOR.capabilities).toEqual({
			readPublic: true,
			readOperator: false,
			dispatch: false,
			admin: false,
		});
	});

	test("admits a valid bearer token as the full-capability operator", () => {
		const result = provider.authorize(req("Bearer s3cret"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.actor).toEqual(OPERATOR_ACTOR);
	});

	test("denies a wrong token instead of degrading it to anonymous", () => {
		const result = provider.authorize(req("Bearer wrong"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.challenge).toContain("invalid_token");
	});

	test("denies a malformed Authorization header instead of degrading it", () => {
		const result = provider.authorize(req("Basic abc"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
	});
});

describe("resolveAuthKind (warren-851b)", () => {
	test("unset resolves to the token default", () => {
		expect(resolveAuthKind({})).toBe("token");
		expect(DEFAULT_AUTH_KIND).toBe("token");
	});

	test("recognizes token and public, trimming surrounding whitespace", () => {
		expect(resolveAuthKind({ WARREN_AUTH: "token" })).toBe("token");
		expect(resolveAuthKind({ WARREN_AUTH: "public" })).toBe("public");
		expect(resolveAuthKind({ WARREN_AUTH: "  public  " })).toBe("public");
	});

	test("throws UnknownAuthProviderError on an unrecognized value", () => {
		expect(() => resolveAuthKind({ WARREN_AUTH: "nonsense" })).toThrow(UnknownAuthProviderError);
	});

	test("names the recognized values in the recovery hint", () => {
		try {
			resolveAuthKind({ WARREN_AUTH: "nonsense" });
			throw new Error("expected resolveAuthKind to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(UnknownAuthProviderError);
			if (!(err instanceof UnknownAuthProviderError)) return;
			expect(err.code).toBe("unknown_auth_provider");
			expect(err.recoveryHint).toContain("token, public");
		}
	});

	/**
	 * The load-bearing assertion of this seam: no degenerate config value
	 * may resolve to `public`. Every one of these either yields the token
	 * default or refuses the boot — never anonymous access to an instance
	 * whose operator did not ask for it.
	 */
	test("every degenerate value fails closed — token or a throw, never public", () => {
		const degenerate = [
			"",
			"   ",
			"PUBLIC",
			"Public",
			"publik",
			"public,token",
			"public;token",
			"1",
			"true",
			"yes",
			"on",
			"null",
			"undefined",
			"*",
			"public read",
		];
		for (const raw of degenerate) {
			let kind: string | undefined;
			try {
				kind = resolveAuthKind({ WARREN_AUTH: raw });
			} catch (err) {
				expect(err).toBeInstanceOf(UnknownAuthProviderError);
				continue;
			}
			expect(kind).toBe("token");
		}
	});
});

describe("resolveAuth backend selection (warren-851b)", () => {
	test("defaults to the token provider — no anonymous access", () => {
		const provider = resolveAuth({ env: { WARREN_API_TOKEN: "s3cret" } });
		expect(provider.authorize(req()).ok).toBe(false);
	});

	test("WARREN_AUTH=public admits anonymous readers and the operator", () => {
		const provider = resolveAuth({ env: { WARREN_API_TOKEN: "s3cret", WARREN_AUTH: "public" } });
		const anon = provider.authorize(req());
		expect(anon.ok).toBe(true);
		if (!anon.ok) return;
		expect(anon.actor).toEqual(ANONYMOUS_ACTOR);
		const operator = provider.authorize(req("Bearer s3cret"));
		expect(operator.ok).toBe(true);
		if (!operator.ok) return;
		expect(operator.actor).toEqual(OPERATOR_ACTOR);
	});

	test("public mode still requires an operator token", () => {
		expect(() => resolveAuth({ env: { WARREN_AUTH: "public" } })).toThrow(ValidationError);
	});

	test("an unrecognized WARREN_AUTH throws even with a valid token", () => {
		expect(() => resolveAuth({ env: { WARREN_API_TOKEN: "s3cret", WARREN_AUTH: "nope" } })).toThrow(
			UnknownAuthProviderError,
		);
	});

	test("noAuth still wins over WARREN_AUTH=public", () => {
		const provider = resolveAuth({ noAuth: true, env: { WARREN_AUTH: "public" } });
		expect(provider).toBe(NO_AUTH);
	});

	test("an explicit kind wins over env.WARREN_AUTH", () => {
		const provider = resolveAuth({
			kind: "token",
			env: { WARREN_API_TOKEN: "s3cret", WARREN_AUTH: "public" },
		});
		expect(provider.authorize(req()).ok).toBe(false);
	});
});

describe("policyAllows (warren-b875)", () => {
	test("anonymous demands nothing of either actor", () => {
		expect(policyAllows(ANONYMOUS_ACTOR, "anonymous")).toBe(true);
		expect(policyAllows(OPERATOR_ACTOR, "anonymous")).toBe(true);
	});

	test("the operator clears every capability", () => {
		for (const policy of ["readPublic", "readOperator", "dispatch", "admin"] as const) {
			expect(policyAllows(OPERATOR_ACTOR, policy)).toBe(true);
		}
	});

	test("the spectator clears readPublic and nothing else", () => {
		expect(policyAllows(ANONYMOUS_ACTOR, "readPublic")).toBe(true);
		for (const policy of ["readOperator", "dispatch", "admin"] as const) {
			expect(policyAllows(ANONYMOUS_ACTOR, policy)).toBe(false);
		}
	});
});
