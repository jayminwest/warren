import { describe, expect, test } from "bun:test";
import { jsonResponse, ndjsonResponse, SECURITY_HEADERS, textResponse } from "./response.ts";

describe("jsonResponse", () => {
	test("carries the baseline security headers (warren-e2a4)", () => {
		const res = jsonResponse(200, { ok: true });
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			expect(res.headers.get(name)).toBe(value);
		}
	});

	test("varies by Authorization so no shared cache serves an operator body to a spectator", () => {
		const res = jsonResponse(200, { ok: true });
		expect(res.headers.get("vary")).toBe("Authorization");
	});

	test("a handler-provided Vary wins over the default", () => {
		const res = jsonResponse(200, { ok: true }, { headers: { vary: "Authorization, Cookie" } });
		expect(res.headers.get("vary")).toBe("Authorization, Cookie");
	});
});

describe("ndjsonResponse", () => {
	test("carries the security headers and Vary: Authorization", () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const res = ndjsonResponse(stream);
		expect(res.headers.get("vary")).toBe("Authorization");
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			expect(res.headers.get(name)).toBe(value);
		}
	});
});

describe("textResponse", () => {
	test("carries the baseline security headers", () => {
		const res = textResponse(200, "ok", "text/plain");
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			expect(res.headers.get(name)).toBe(value);
		}
	});
});
