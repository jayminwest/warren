import { describe, expect, test } from "bun:test";
import {
	isWarrenApiPath,
	parsePreviewPathPrefix,
	parseRunIdFromHost,
	parseRunIdFromReferer,
} from "./route-match.ts";

const HOST = "preview.warren.example.com";

describe("parseRunIdFromHost", () => {
	test("matches `run-<id>.<host>`", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com", HOST)).toBe("abc");
		expect(parseRunIdFromHost("run-run_abc123.preview.warren.example.com", HOST)).toBe(
			"run_abc123",
		);
	});

	test("tolerates an optional port suffix on the Host header", () => {
		expect(parseRunIdFromHost("run-abc.preview.warren.example.com:8080", HOST)).toBe("abc");
	});

	test("rejects the bare warren host", () => {
		expect(parseRunIdFromHost("preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects deeper labels (security: no nested-subdomain spoofing)", () => {
		expect(parseRunIdFromHost("foo.run-abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects non-`run-` prefix", () => {
		expect(parseRunIdFromHost("abc.preview.warren.example.com", HOST)).toBeNull();
	});

	test("rejects null + empty", () => {
		expect(parseRunIdFromHost(null, HOST)).toBeNull();
		expect(parseRunIdFromHost("", HOST)).toBeNull();
	});
});

describe("parsePreviewPathPrefix", () => {
	test("matches `/p/<runId>/<rest>`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/foo/bar");
		expect(r).toEqual({ runId: "run_abc", rest: "/foo/bar" });
	});

	test("matches `/p/<runId>/` with trailing slash and empty rest → `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc/");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("matches `/p/<runId>` (no trailing slash) and defaults rest to `/`", () => {
		const r = parsePreviewPathPrefix("/p/run_abc");
		expect(r).toEqual({ runId: "run_abc", rest: "/" });
	});

	test("returns null for non-preview paths", () => {
		expect(parsePreviewPathPrefix("/")).toBeNull();
		expect(parsePreviewPathPrefix("/runs/run_abc")).toBeNull();
		expect(parsePreviewPathPrefix("/p")).toBeNull();
		expect(parsePreviewPathPrefix("/p/")).toBeNull();
		expect(parsePreviewPathPrefix("/projects")).toBeNull();
	});

	test("rejects path-traversal in the runId segment", () => {
		// `.` and `/` are not in the charset; a path-traversal attempt
		// either gets eaten by URL normalization upstream or returns null
		// here. The 'rest' segment can contain anything — it's just the
		// upstream URL path.
		expect(parsePreviewPathPrefix("/p/../etc/passwd")).toBeNull();
		expect(parsePreviewPathPrefix("/p/run.abc/foo")).toBeNull();
	});

	test("rest preserves query separator boundary (called with pathname only)", () => {
		// parsePreviewPathPrefix takes a pathname, not a full URL — the
		// proxy handler keeps `url.search` separately and re-attaches it
		// at forward time. So no `?` shows up in a real call.
		const r = parsePreviewPathPrefix("/p/run_abc/api/v1/list");
		expect(r).toEqual({ runId: "run_abc", rest: "/api/v1/list" });
	});
});

describe("parseRunIdFromReferer (warren-63e1)", () => {
	test("returns the runId when Referer points at /p/<runId>/...", () => {
		expect(parseRunIdFromReferer("https://warren.example.com/p/run_abc/")).toBe("run_abc");
		expect(parseRunIdFromReferer("https://warren.example.com/p/run_abc/inner/page")).toBe(
			"run_abc",
		);
	});

	test("returns null for non-preview pathnames", () => {
		expect(parseRunIdFromReferer("https://warren.example.com/")).toBeNull();
		expect(parseRunIdFromReferer("https://warren.example.com/runs/abc")).toBeNull();
		expect(parseRunIdFromReferer("https://warren.example.com/p")).toBeNull();
		expect(parseRunIdFromReferer("https://warren.example.com/p/")).toBeNull();
	});

	test("returns null for null / empty / malformed values", () => {
		expect(parseRunIdFromReferer(null)).toBeNull();
		expect(parseRunIdFromReferer("")).toBeNull();
		expect(parseRunIdFromReferer("not a url")).toBeNull();
	});

	test("origin is not constrained — cross-origin referer still names the run", () => {
		// Browser default policy ships same-origin referers; non-same-origin
		// referers still get parsed because the cookie check below anchors
		// authorization on the runId-bound signature.
		expect(parseRunIdFromReferer("https://other.example.com/p/run_abc/")).toBe("run_abc");
	});
});

describe("warren-api-prefixes-stay-in-sync (warren-63e1)", () => {
	test("local WARREN_API_PATH_PREFIXES matches handlers.API_PREFIXES", async () => {
		// proxy/route-match.ts duplicates the prefix list to avoid pulling
		// all of handlers/index.ts into the preview tree. This test makes
		// the duplication safe by asserting parity at build time — adding
		// a new API surface to handlers/index.ts surfaces here as a failed
		// assertion.
		const handlers = await import("../../server/handlers/index.ts");
		const { API_ROUTE_PATTERNS } = handlers;
		// Derive prefixes from the pattern list: the first path segment.
		const observedPrefixes = new Set<string>();
		for (const { pattern } of API_ROUTE_PATTERNS) {
			const segments = pattern.split("/").filter((s) => s.length > 0);
			const first = segments[0];
			if (first !== undefined) observedPrefixes.add(`/${first}`);
		}
		// Every observed prefix must be in our local list.
		for (const p of observedPrefixes) {
			expect(isWarrenApiPath(p)).toBe(true);
		}
	});
});

describe("isWarrenApiPath (warren-63e1)", () => {
	test("matches known warren API prefixes", () => {
		expect(isWarrenApiPath("/runs")).toBe(true);
		expect(isWarrenApiPath("/runs/run_abc")).toBe(true);
		expect(isWarrenApiPath("/projects")).toBe(true);
		expect(isWarrenApiPath("/agents/foo")).toBe(true);
		expect(isWarrenApiPath("/healthz")).toBe(true);
		expect(isWarrenApiPath("/readyz")).toBe(true);
		expect(isWarrenApiPath("/version")).toBe(true);
		expect(isWarrenApiPath("/preview/config")).toBe(true);
	});

	test("rejects non-API paths", () => {
		expect(isWarrenApiPath("/")).toBe(false);
		expect(isWarrenApiPath("/_next/static/foo.js")).toBe(false);
		expect(isWarrenApiPath("/favicon.ico")).toBe(false);
		expect(isWarrenApiPath("/assets/x.svg")).toBe(false);
	});

	test("does not match prefixes that share a non-`/` boundary", () => {
		// `/runscape` shouldn't count as `/runs` — only `/runs` or `/runs/...`.
		expect(isWarrenApiPath("/runscape")).toBe(false);
		expect(isWarrenApiPath("/projectsx")).toBe(false);
	});
});
