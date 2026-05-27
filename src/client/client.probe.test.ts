import { describe, expect, test } from "bun:test";
import { WarrenClient, WarrenUnreachableError } from "./index.ts";
import { jsonResponse, stub } from "./test-helpers.ts";

describe("WarrenClient.probe", () => {
	test("resolves when warren returns 200 from /healthz", async () => {
		const stubFetch = stub(async (input) => {
			expect(String(input)).toContain("/healthz");
			return jsonResponse(200, { ok: true });
		});
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		await expect(c.probe()).resolves.toBeUndefined();
	});

	test("throws WarrenUnreachableError when fetch rejects (connection refused)", async () => {
		const stubFetch = stub(async () => {
			throw new TypeError("fetch failed");
		});
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		const promise = c.probe();
		await expect(promise).rejects.toBeInstanceOf(WarrenUnreachableError);
		await expect(promise).rejects.toMatchObject({
			message: expect.stringContaining("warren unreachable at http://warren.local"),
		});
	});

	test("times out and throws WarrenUnreachableError when warren hangs", async () => {
		const stubFetch = stub(() => new Promise<Response>(() => {}));
		const c = new WarrenClient({
			config: { baseUrl: "http://warren.local" },
			fetch: stubFetch,
		});
		await expect(c.probe(50)).rejects.toBeInstanceOf(WarrenUnreachableError);
	});
});
