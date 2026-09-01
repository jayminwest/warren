import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "../github/test-helpers.ts";
import { buildAdoHeaders, classifyAdoHttpError, requestAdo } from "./http.ts";

const URL_UNDER_TEST =
	"https://dev.azure.com/acme/Widgets/_apis/git/repositories/widget/refs?api-version=7.1";

describe("buildAdoHeaders", () => {
	test("sends the PAT as basic auth with an empty username", () => {
		const headers = buildAdoHeaders("secret-pat");
		expect(headers.authorization).toBe(`Basic ${Buffer.from(":secret-pat").toString("base64")}`);
		expect(headers.accept).toBe("application/json");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["user-agent"]).toBe("warren-forge-ado");
	});

	test("honours an Accept override for log endpoints", () => {
		expect(buildAdoHeaders("x", "text/plain").accept).toBe("text/plain");
	});
});

describe("classifyAdoHttpError", () => {
	const classify = (status: number, headers: Record<string, string> = {}) =>
		classifyAdoHttpError(status, new Headers(headers), "body", "GET /x");

	test("maps the status line onto the seam kinds", () => {
		expect(classify(401).kind).toBe("unauthorized");
		expect(classify(403).kind).toBe("forbidden");
		expect(classify(404).kind).toBe("not_found");
		expect(classify(409).kind).toBe("conflict");
		expect(classify(500).kind).toBe("http_error");
		expect(classify(422).kind).toBe("http_error");
	});

	test("reads the 203 sign-in page as a rejected credential", () => {
		const error = classify(203);
		expect(error.kind).toBe("unauthorized");
		expect(error.message).toMatch(/sign-in page/);
	});

	test("carries Retry-After on a 429", () => {
		const error = classify(429, { "retry-after": "7" });
		expect(error.kind).toBe("rate_limited");
		expect(error.retryAfterMs).toBe(7000);
	});
});

describe("requestAdo", () => {
	test("returns the response on 2xx and pins the api version in the URL it was given", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { value: [] })]);
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch,
		});
		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe(URL_UNDER_TEST);
		expect(calls[0]?.method).toBe("GET");
	});

	test("serializes a body and the method", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(201, {})]);
		await requestAdo({
			url: URL_UNDER_TEST,
			method: "POST",
			body: { a: 1 },
			token: "t",
			context: "POST /refs",
			fetch,
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toBe('{"a":1}');
	});

	test("classifies a 203 as unauthorized even though fetch reports it ok", async () => {
		const { fetch } = recordingFetch([new Response("<html>sign in</html>", { status: 203 })]);
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unauthorized");
	});

	test("retries a 5xx and then succeeds", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(503, { message: "busy" }),
			jsonResponse(200, { value: [] }),
		]);
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch,
			retry: { sleep: async () => {} },
		});
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("does not retry a 4xx", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(404, { message: "nope" })]);
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch,
		});
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("surfaces a thrown fetch as a network error, never a throw", async () => {
		const fetchImpl = (() => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch: fetchImpl,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toMatch(/ECONNRESET/);
		}
	});

	test("keeps the deadline armed while the body is read", async () => {
		const fetchImpl = ((_url: string, init?: RequestInit) => {
			const stalled = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{"));
					init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
				},
			});
			return Promise.resolve(
				new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }),
			);
		}) as unknown as typeof fetch;
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch: fetchImpl,
			timeoutMs: 20,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toMatch(/timed out|TimeoutError|timeout/i);
		}
	});

	test("hands every call a signal that fires at the deadline", async () => {
		const fetchImpl = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const result = await requestAdo({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /refs",
			fetch: fetchImpl,
			timeoutMs: 20,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toMatch(/timed out|TimeoutError|timeout/i);
		}
	});
});
