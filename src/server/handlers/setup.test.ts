import { describe, expect, test } from "bun:test";
import { SetupHandoffStore, setupRedemptionUrl } from "../setup-handoff.ts";
import type { RouteContext } from "../types.ts";
import { setupHandoffHandler } from "./setup.ts";

function ctxFor(url: string): RouteContext {
	return {
		request: new Request(url),
		url: new URL(url),
		params: {},
		requestId: "req-test",
		logger: {
			info() {},
			warn() {},
			error() {},
			debug() {},
			child() {
				return this;
			},
		} as unknown as RouteContext["logger"],
	};
}

const BASE = "http://127.0.0.1:8378";

describe("SetupHandoffStore", () => {
	test("redeem returns the bound token exactly once", () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok");
		expect(store.redeem("code-1")).toBe("tok");
		expect(store.redeem("code-1")).toBeNull();
	});

	test("an unknown code never redeems", () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok");
		expect(store.redeem("nope")).toBeNull();
	});

	test("a code past its TTL is swept and does not redeem", () => {
		let now = 1000;
		const store = new SetupHandoffStore(
			() => now,
			600_000,
			() => "code-1",
		);
		store.mint("tok");
		now = 1000 + 600_001;
		expect(store.redeem("code-1")).toBeNull();
		expect(store.size).toBe(0);
	});

	test("minted codes are unguessable-length random strings", () => {
		const store = new SetupHandoffStore();
		const a = store.mint("tok");
		const b = store.mint("tok");
		expect(a).not.toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(32);
	});
});

describe("setupRedemptionUrl", () => {
	test("joins the base URL and URL-encodes the code", () => {
		expect(setupRedemptionUrl("http://127.0.0.1:8080", "abc")).toBe(
			"http://127.0.0.1:8080/setup?code=abc",
		);
		expect(setupRedemptionUrl("http://127.0.0.1:8080/", "a b+c")).toBe(
			"http://127.0.0.1:8080/setup?code=a%20b%2Bc",
		);
	});
});

describe("setupHandoffHandler", () => {
	test("answers 404 when the boot did not arm the handoff", async () => {
		const res = await setupHandoffHandler(undefined)(ctxFor(`${BASE}/setup?code=x`));
		expect(res.status).toBe(404);
		await res.body?.cancel();
	});

	test("a live code redeems into a page that stores the UI's token key", async () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok123");
		const res = await setupHandoffHandler(store)(ctxFor(`${BASE}/setup?code=code-1`));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'nonce-");
		const html = await res.text();
		// The token lands in the exact localStorage key the SPA login writes,
		// embedded JSON-escaped so it cannot break out of the script.
		expect(html).toContain('"warren.apiToken"');
		expect(html).toContain('"tok123"');
		expect(html).toContain('location.replace("/")');
	});

	test("a spent code returns a clean 400 error page pointing at the login", async () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok123");
		store.redeem("code-1");
		const res = await setupHandoffHandler(store)(ctxFor(`${BASE}/setup?code=code-1`));
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("exactly once");
		expect(html).not.toContain("tok123");
	});

	test("a missing ?code= parameter is a 400, not a 500", async () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok123");
		const res = await setupHandoffHandler(store)(ctxFor(`${BASE}/setup`));
		expect(res.status).toBe(400);
		await res.body?.cancel();
	});

	test("a token carrying markup is escaped into the script literal", async () => {
		const store = new SetupHandoffStore(
			() => 1000,
			600_000,
			() => "code-1",
		);
		store.mint("tok</script><img src=x>");
		const res = await setupHandoffHandler(store)(ctxFor(`${BASE}/setup?code=code-1`));
		const html = await res.text();
		expect(html).not.toContain("</script><img");
		expect(html).toContain("\\u003c");
	});
});
