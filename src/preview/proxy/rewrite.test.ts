import { describe, expect, test } from "bun:test";
import {
	HTML_HEAD_LOOKAHEAD_BYTES,
	injectBaseHref,
	isHtmlContentType,
	rewriteLocationHeader,
	rewriteRootRelativeAttrs,
} from "./rewrite.ts";

describe("isHtmlContentType", () => {
	test("matches bare text/html", () => {
		expect(isHtmlContentType("text/html")).toBe(true);
	});

	test("matches text/html with charset parameter", () => {
		expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
		expect(isHtmlContentType("text/html;charset=UTF-8")).toBe(true);
		expect(isHtmlContentType("TEXT/HTML")).toBe(true);
	});

	test("rejects other content types", () => {
		expect(isHtmlContentType("application/json")).toBe(false);
		expect(isHtmlContentType("application/xhtml+xml")).toBe(false);
		expect(isHtmlContentType("text/plain")).toBe(false);
		expect(isHtmlContentType("text/css")).toBe(false);
		expect(isHtmlContentType("application/javascript")).toBe(false);
	});

	test("rejects null", () => {
		expect(isHtmlContentType(null)).toBe(false);
	});
});

describe("rewriteLocationHeader", () => {
	const PREFIX = "/p/run_abc";

	test("prefixes a same-origin absolute path", () => {
		expect(rewriteLocationHeader("/signin", PREFIX)).toBe("/p/run_abc/signin");
		expect(rewriteLocationHeader("/", PREFIX)).toBe("/p/run_abc/");
		expect(rewriteLocationHeader("/api/v1/list?x=1", PREFIX)).toBe("/p/run_abc/api/v1/list?x=1");
	});

	test("leaves an absolute URL untouched", () => {
		expect(rewriteLocationHeader("https://example.com/foo", PREFIX)).toBe(
			"https://example.com/foo",
		);
		expect(rewriteLocationHeader("http://other/path", PREFIX)).toBe("http://other/path");
	});

	test("leaves a scheme-relative URL untouched", () => {
		expect(rewriteLocationHeader("//cdn.example.com/asset.js", PREFIX)).toBe(
			"//cdn.example.com/asset.js",
		);
	});

	test("does not double-prefix a value already under the path prefix", () => {
		expect(rewriteLocationHeader("/p/run_abc/", PREFIX)).toBe("/p/run_abc/");
		expect(rewriteLocationHeader("/p/run_abc/foo", PREFIX)).toBe("/p/run_abc/foo");
		expect(rewriteLocationHeader("/p/run_abc", PREFIX)).toBe("/p/run_abc");
	});

	test("does prefix a path that incidentally starts with a different /p/ run id", () => {
		// `/p/run_other/foo` is a different run's prefix; from this run's
		// proxy view it's just an opaque absolute path that should escape
		// into `/p/<this-run>/p/run_other/foo`. The 404 from the upstream is
		// the safer failure than smuggling a request into the sibling run.
		expect(rewriteLocationHeader("/p/run_other/foo", PREFIX)).toBe("/p/run_abc/p/run_other/foo");
	});

	test("leaves empty string untouched", () => {
		expect(rewriteLocationHeader("", PREFIX)).toBe("");
	});

	test("leaves non-absolute paths untouched (relative or fragment)", () => {
		// Per SPEC §11.L only same-origin absolute paths (start with `/`)
		// are rewritten. Relative / fragment values stay verbatim.
		expect(rewriteLocationHeader("foo/bar", PREFIX)).toBe("foo/bar");
		expect(rewriteLocationHeader("#anchor", PREFIX)).toBe("#anchor");
	});
});

describe("injectBaseHref", () => {
	const PREFIX = "/p/run_abc";
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	function inject(html: string): string {
		const out = injectBaseHref(enc.encode(html), PREFIX);
		if (out === null) throw new Error("expected injectBaseHref to rewrite, got null");
		return dec.decode(out);
	}

	test("injects <base> immediately after the opening <head> tag", () => {
		expect(inject("<!doctype html><html><head><title>x</title></head><body>y</body></html>")).toBe(
			'<!doctype html><html><head><base href="/p/run_abc/"><title>x</title></head><body>y</body></html>',
		);
	});

	test("tolerates attributes on the <head> tag", () => {
		expect(inject('<html><head lang="en" dir="ltr"><title>x</title></head></html>')).toBe(
			'<html><head lang="en" dir="ltr"><base href="/p/run_abc/"><title>x</title></head></html>',
		);
	});

	test("is case-insensitive on the head tag", () => {
		expect(inject("<HTML><HEAD><TITLE>x</TITLE></HEAD></HTML>")).toBe(
			'<HTML><HEAD><base href="/p/run_abc/"><TITLE>x</TITLE></HEAD></HTML>',
		);
	});

	test("returns null (no-op) when a <base> element is already present", () => {
		const html = '<html><head><base href="/whatever/"><title>x</title></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("returns null (no-op) when the document already has the path-mode <base>", () => {
		// Re-proxying a warren-served document must be idempotent.
		const html = '<html><head><base href="/p/run_abc/"></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("recognizes self-closing <base /> as already present", () => {
		const html = '<html><head><base href="/x/" /></head></html>';
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("returns null when there is no <head> in the lookahead window", () => {
		const html = "<html><body>no head here</body></html>";
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("does not match <basefont> as a <base> element", () => {
		// Deprecated tag — but if the upstream uses it, we still want to
		// inject our own <base>.
		expect(inject("<html><head><basefont color=red><title>x</title></head></html>")).toContain(
			'<head><base href="/p/run_abc/"><basefont',
		);
	});

	test("does nothing when <head> sits beyond the 64 KiB lookahead window", () => {
		// Pad with a giant HTML comment so the <head> tag is past the
		// lookahead bound.
		const pad = "x".repeat(HTML_HEAD_LOOKAHEAD_BYTES);
		const html = `<!--${pad}--><html><head></head></html>`;
		expect(injectBaseHref(enc.encode(html), PREFIX)).toBeNull();
	});

	test("preserves arbitrary UTF-8 bytes in the body verbatim", () => {
		expect(inject("<html><head></head><body>héllo 🌳 こんにちは</body></html>")).toBe(
			'<html><head><base href="/p/run_abc/"></head><body>héllo 🌳 こんにちは</body></html>',
		);
	});
});

describe("rewriteRootRelativeAttrs (warren-63e1)", () => {
	const PREFIX = "/p/run_abc";
	const enc = new TextEncoder();
	const dec = new TextDecoder();

	function rewrite(html: string): string | null {
		const out = rewriteRootRelativeAttrs(enc.encode(html), PREFIX);
		return out === null ? null : dec.decode(out);
	}

	test("prefixes href and src absolute paths", () => {
		expect(
			rewrite(
				'<head><link rel="stylesheet" href="/_next/static/css/x.css"><script src="/_next/static/chunks/main.js"></script></head>',
			),
		).toBe(
			'<head><link rel="stylesheet" href="/p/run_abc/_next/static/css/x.css"><script src="/p/run_abc/_next/static/chunks/main.js"></script></head>',
		);
	});

	test("tolerates single-quoted attribute values", () => {
		expect(rewrite("<head><script src='/x.js'></script></head>")).toBe(
			"<head><script src='/p/run_abc/x.js'></script></head>",
		);
	});

	test("skips protocol-relative URLs (//host/...)", () => {
		expect(rewrite('<head><link href="//cdn.example.com/x.css"></head>')).toBeNull();
	});

	test("skips absolute URLs (http: / https:)", () => {
		expect(rewrite('<head><link href="https://cdn.example.com/x.css"></head>')).toBeNull();
		expect(rewrite('<head><link href="http://cdn.example.com/x.css"></head>')).toBeNull();
	});

	test("skips data:, #, and ? values (don't start with /)", () => {
		expect(rewrite('<head><link href="data:image/png;base64,abc"></head>')).toBeNull();
		expect(rewrite('<head><a href="#section"></a></head>')).toBeNull();
		expect(rewrite('<head><a href="?q=1"></a></head>')).toBeNull();
	});

	test("skips values already prefixed with /p/<id>/", () => {
		// Idempotent: re-proxying warren-served HTML is a no-op.
		expect(rewrite('<head><script src="/p/run_abc/x.js"></script></head>')).toBeNull();
	});

	test("does NOT match a substring attribute (e.g. data-src)", () => {
		// Boundary check rejects matches where the previous byte isn't a
		// whitespace / `<` / `/`.
		expect(rewrite('<head><img data-src="/x.png"></head>')).toBeNull();
	});

	test("rewrites each entry in a srcset", () => {
		expect(rewrite('<head><img srcset="/a.png 1x, /b.png 2x, /c.png 3x"></head>')).toBe(
			'<head><img srcset="/p/run_abc/a.png 1x, /p/run_abc/b.png 2x, /p/run_abc/c.png 3x"></head>',
		);
	});

	test("partial srcset rewrite leaves protocol-relative entries alone", () => {
		expect(rewrite('<head><img srcset="/a.png 1x, //cdn.example.com/b.png 2x"></head>')).toBe(
			'<head><img srcset="/p/run_abc/a.png 1x, //cdn.example.com/b.png 2x"></head>',
		);
	});

	test("returns null when nothing in the window matches", () => {
		expect(rewrite("<head><title>x</title></head>")).toBeNull();
	});

	test("stays within the lookahead window — bytes past the cap pass through unchanged", () => {
		// Padding fills the lookahead with non-matching bytes; the href past
		// the cap must NOT be rewritten.
		const padding = "x".repeat(HTML_HEAD_LOOKAHEAD_BYTES);
		const html = `${padding}<link href="/late.css">`;
		const out = rewrite(html);
		expect(out).toBeNull();
	});
});
