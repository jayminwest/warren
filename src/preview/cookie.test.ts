import { describe, expect, test } from "bun:test";
import {
	COOKIE_NAME,
	COOKIE_VERSION,
	createPreviewAuth,
	DEFAULT_COOKIE_TTL_MS,
	extractCookieValue,
	previewCookieName,
} from "./cookie.ts";

const TOKEN = "test-token-very-secret-1234567890abcdef";

describe("createPreviewAuth", () => {
	test("empty-token construction throws", () => {
		expect(() => createPreviewAuth("")).toThrow();
	});
});

describe("createPreviewAuth.signCookie / verifyCookie", () => {
	test("round-trips a fresh cookie", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", now);
		expect(cookie.name).toBe(COOKIE_NAME);
		expect(cookie.value.startsWith(`${COOKIE_VERSION}.run_abc.`)).toBe(true);
		expect(auth.verifyCookie(`${cookie.name}=${cookie.value}`, "run_abc", now)).toBe(true);
	});

	test("Set-Cookie header includes scoped attributes when subdomain mode pins a Domain", () => {
		const auth = createPreviewAuth(TOKEN, {
			scope: { mode: "subdomain", cookieDomain: ".preview.example.com" },
		});
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.setCookieHeader).toContain(`${COOKIE_NAME}=`);
		expect(cookie.setCookieHeader).toContain("Path=/");
		expect(cookie.setCookieHeader).toContain("HttpOnly");
		expect(cookie.setCookieHeader).toContain("SameSite=Lax");
		expect(cookie.setCookieHeader).toContain("Secure");
		expect(cookie.setCookieHeader).toContain("Domain=.preview.example.com");
		expect(cookie.setCookieHeader).toContain("Max-Age=");
	});

	test("path mode emits Path=/ with a per-run cookie name and no Domain attribute (warren-63e1)", () => {
		const auth = createPreviewAuth(TOKEN, { scope: { mode: "path" } });
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.name).toBe(`${COOKIE_NAME}_run_abc`);
		expect(cookie.setCookieHeader).toContain(`${COOKIE_NAME}_run_abc=`);
		expect(cookie.setCookieHeader).toContain("Path=/");
		expect(cookie.setCookieHeader).not.toContain("Path=/p/");
		expect(cookie.setCookieHeader).not.toContain("Domain=");
		expect(cookie.setCookieHeader).toContain("HttpOnly");
		expect(cookie.setCookieHeader).toContain("SameSite=Lax");
		expect(cookie.setCookieHeader).toContain("Secure");
		expect(cookie.setCookieHeader).toContain("Max-Age=");
	});

	test("two runs scoped under the same path-mode auth get disjoint cookie names", () => {
		const auth = createPreviewAuth(TOKEN, { scope: { mode: "path" } });
		const a = auth.signCookie("run_abc", new Date());
		const b = auth.signCookie("run_xyz", new Date());
		expect(a.name).toBe(`${COOKIE_NAME}_run_abc`);
		expect(b.name).toBe(`${COOKIE_NAME}_run_xyz`);
		// Per-run name isolation: a's cookie value must not authenticate b's runId.
		const header = `${a.name}=${a.value}; ${b.name}=${b.value}`;
		expect(auth.verifyCookie(header, "run_abc", new Date())).toBe(true);
		expect(auth.verifyCookie(header, "run_xyz", new Date())).toBe(true);
		// `warren_preview_run_abc` is not `warren_preview_run_xyz`, so a stray
		// sibling cookie can't satisfy verification for the other run.
		expect(auth.verifyCookie(`${a.name}=${a.value}`, "run_xyz", new Date())).toBe(false);
	});

	test("previewCookieName returns per-run name in path mode, bare name in subdomain mode", () => {
		expect(previewCookieName("run_abc", "path")).toBe(`${COOKIE_NAME}_run_abc`);
		expect(previewCookieName("run_abc", "subdomain")).toBe(COOKIE_NAME);
	});

	test("default scope (no options) stays host-only subdomain — no Domain attribute", () => {
		const auth = createPreviewAuth(TOKEN);
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.setCookieHeader).toContain("Path=/");
		expect(cookie.setCookieHeader).not.toContain("Domain=");
	});

	test("Secure attribute can be disabled for local http loopback tests", () => {
		const auth = createPreviewAuth(TOKEN, { secure: false });
		const cookie = auth.signCookie("run_abc", new Date());
		expect(cookie.setCookieHeader).not.toContain("Secure");
	});

	test("expired cookie fails verification", () => {
		const auth = createPreviewAuth(TOKEN);
		const issuedAt = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", issuedAt, 60_000);
		const later = new Date(issuedAt.getTime() + 120_000);
		expect(auth.verifyCookie(`${cookie.name}=${cookie.value}`, "run_abc", later)).toBe(false);
	});

	test("verifying with the wrong runId fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		expect(auth.verifyCookie(`${cookie.name}=${cookie.value}`, "run_xyz", now)).toBe(false);
	});

	test("a tampered signature fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		const tampered = `${cookie.value.slice(0, -1)}X`;
		expect(auth.verifyCookie(`${cookie.name}=${tampered}`, "run_abc", now)).toBe(false);
	});

	test("a tampered runId in payload fails (sig won't match)", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		const cookie = auth.signCookie("run_abc", now);
		const parts = cookie.value.split(".");
		parts[1] = "run_xyz";
		const forged = parts.join(".");
		// In subdomain mode the cookie name doesn't change with runId, so this
		// still tests the sig check (the payload runId differs from the verified runId).
		expect(auth.verifyCookie(`${cookie.name}=${forged}`, "run_xyz", now)).toBe(false);
	});

	test("missing or absent cookie header fails", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date();
		expect(auth.verifyCookie(null, "run_abc", now)).toBe(false);
		expect(auth.verifyCookie("", "run_abc", now)).toBe(false);
		expect(auth.verifyCookie("session=other", "run_abc", now)).toBe(false);
	});

	test("two PreviewAuth instances built from different tokens reject each other's cookies", () => {
		const auth1 = createPreviewAuth(TOKEN);
		const auth2 = createPreviewAuth(`${TOKEN}-other`);
		const now = new Date();
		const cookie = auth1.signCookie("run_abc", now);
		expect(auth2.verifyCookie(`${cookie.name}=${cookie.value}`, "run_abc", now)).toBe(false);
	});

	test("ttlMs default is 24h", () => {
		const auth = createPreviewAuth(TOKEN);
		const now = new Date("2026-01-01T00:00:00Z");
		const cookie = auth.signCookie("run_abc", now);
		expect(cookie.expiresAt.getTime()).toBe(now.getTime() + DEFAULT_COOKIE_TTL_MS);
	});

	test("rejects non-positive ttl", () => {
		const auth = createPreviewAuth(TOKEN);
		expect(() => auth.signCookie("run_abc", new Date(), 0)).toThrow();
		expect(() => auth.signCookie("run_abc", new Date(), -1)).toThrow();
		expect(() => auth.signCookie("", new Date())).toThrow();
	});
});

describe("extractCookieValue", () => {
	test("extracts a single cookie", () => {
		expect(extractCookieValue("warren_preview=abc", "warren_preview")).toBe("abc");
	});

	test("extracts from a multi-cookie header tolerating whitespace", () => {
		expect(extractCookieValue("a=1; warren_preview=abc; b=2", "warren_preview")).toBe("abc");
		expect(extractCookieValue("a=1;warren_preview=abc;b=2", "warren_preview")).toBe("abc");
	});

	test("returns null when absent", () => {
		expect(extractCookieValue("a=1", "warren_preview")).toBe(null);
		expect(extractCookieValue("", "warren_preview")).toBe(null);
	});
});
