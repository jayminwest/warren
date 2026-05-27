import { describe, expect, test } from "bun:test";
import {
	bindRequestIdLogger,
	extractOrGenerateRequestId,
	isValidRequestId,
	REQUEST_ID_HEADER,
	stampRequestId,
} from "./request-id.ts";
import type { Logger } from "./types.ts";

describe("isValidRequestId", () => {
	test("accepts uuid-shaped ids", () => {
		expect(isValidRequestId("11111111-1111-1111-1111-111111111111")).toBe(true);
	});

	test("accepts alphanumerics, dots, dashes, underscores", () => {
		expect(isValidRequestId("trace_42.abc-XYZ")).toBe(true);
	});

	test("rejects empty + overlong values", () => {
		expect(isValidRequestId("")).toBe(false);
		expect(isValidRequestId("a".repeat(129))).toBe(false);
	});

	test("rejects values with whitespace or control bytes", () => {
		expect(isValidRequestId("has space")).toBe(false);
		expect(isValidRequestId("crlf\r\ninjected")).toBe(false);
		expect(isValidRequestId("semi;colon")).toBe(false);
	});
});

describe("extractOrGenerateRequestId", () => {
	test("honours a well-formed inbound header", () => {
		const req = new Request("http://x/", { headers: { [REQUEST_ID_HEADER]: "abc-123" } });
		expect(extractOrGenerateRequestId(req)).toBe("abc-123");
	});

	test("mints a fresh uuid when the header is missing", () => {
		const id = extractOrGenerateRequestId(new Request("http://x/"));
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("rejects hostile header values and mints a fresh id", () => {
		const req = new Request("http://x/", { headers: { [REQUEST_ID_HEADER]: "bad value\r\n" } });
		const id = extractOrGenerateRequestId(req);
		expect(id).not.toBe("bad value\r\n");
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("stampRequestId", () => {
	test("adds X-Request-ID header to a fresh response", () => {
		const stamped = stampRequestId(new Response("ok"), "req-1");
		expect(stamped.headers.get(REQUEST_ID_HEADER)).toBe("req-1");
	});

	test("overwrites a prior request-id so the wire value wins", () => {
		const r = new Response("ok", { headers: { [REQUEST_ID_HEADER]: "stale" } });
		expect(stampRequestId(r, "fresh").headers.get(REQUEST_ID_HEADER)).toBe("fresh");
	});

	test("preserves status and body", async () => {
		const r = new Response("hello", { status: 418 });
		const stamped = stampRequestId(r, "req-2");
		expect(stamped.status).toBe(418);
		expect(await stamped.text()).toBe("hello");
	});
});

describe("bindRequestIdLogger", () => {
	test("uses .child() when the base logger exposes one", () => {
		const calls: Array<{ method: string; obj: object; msg?: string }> = [];
		const child: Logger = {
			info: (obj, msg) => calls.push({ method: "info", obj, msg }),
			warn: () => {},
			error: () => {},
		};
		const base = {
			info: () => {},
			warn: () => {},
			error: () => {},
			child: (bindings: object) => {
				expect(bindings).toEqual({ request_id: "rid-1" });
				return child;
			},
		};
		const bound = bindRequestIdLogger(base as unknown as Logger, "rid-1");
		bound.info({ a: 1 }, "hi");
		expect(calls).toEqual([{ method: "info", obj: { a: 1 }, msg: "hi" }]);
	});

	test("falls back to a manual shim that injects request_id", () => {
		const calls: object[] = [];
		const base: Logger = {
			info: (obj) => calls.push(obj),
			warn: (obj) => calls.push(obj),
			error: (obj) => calls.push(obj),
		};
		const bound = bindRequestIdLogger(base, "rid-2");
		bound.info({ a: 1 });
		bound.warn({ b: 2 });
		bound.error({ c: 3 });
		expect(calls).toEqual([
			{ a: 1, request_id: "rid-2" },
			{ b: 2, request_id: "rid-2" },
			{ c: 3, request_id: "rid-2" },
		]);
	});
});
