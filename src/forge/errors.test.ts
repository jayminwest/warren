import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { FORGE_ERROR_KINDS } from "../core/wire.ts";
import { FORGE_ERROR_HTTP_STATUS, forgeErrorHttpStatusFor, UnknownForgeError } from "./errors.ts";

describe("UnknownForgeError", () => {
	test("extends WarrenError with the unknown_forge code", () => {
		const err = new UnknownForgeError("WARREN_FORGE names an unknown forge: gitlab", {
			recoveryHint: "pick one of: github, fake",
		});
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("unknown_forge");
		expect(err.name).toBe("UnknownForgeError");
		expect(err.recoveryHint).toBe("pick one of: github, fake");
	});
});

describe("FORGE_ERROR_HTTP_STATUS", () => {
	test("covers every canonical ForgeErrorKind exactly once", () => {
		expect(Object.keys(FORGE_ERROR_HTTP_STATUS).sort()).toEqual([...FORGE_ERROR_KINDS].sort());
	});

	test("maps domain-caused kinds to 4xx and transport kinds to 502", () => {
		expect(FORGE_ERROR_HTTP_STATUS.not_found).toBe(404);
		expect(FORGE_ERROR_HTTP_STATUS.conflict).toBe(409);
		expect(FORGE_ERROR_HTTP_STATUS.rate_limited).toBe(429);
		expect(FORGE_ERROR_HTTP_STATUS.unsupported).toBe(424);
		expect(FORGE_ERROR_HTTP_STATUS.network).toBe(502);
		expect(FORGE_ERROR_HTTP_STATUS.http_error).toBe(502);
	});
});

describe("forgeErrorHttpStatusFor", () => {
	test("resolves a ForgeError-shaped value by its kind", () => {
		expect(forgeErrorHttpStatusFor({ kind: "not_found", detail: "gone" })).toBe(404);
		expect(forgeErrorHttpStatusFor({ kind: "rate_limited", detail: "slow down" })).toBe(429);
	});

	test("returns undefined for non-objects, wrong shapes, and unknown kinds", () => {
		expect(forgeErrorHttpStatusFor(null)).toBeUndefined();
		expect(forgeErrorHttpStatusFor("not_found")).toBeUndefined();
		expect(forgeErrorHttpStatusFor({ detail: "no kind" })).toBeUndefined();
		expect(forgeErrorHttpStatusFor({ kind: 42 })).toBeUndefined();
		expect(forgeErrorHttpStatusFor({ kind: "not_a_kind" })).toBeUndefined();
	});
});
