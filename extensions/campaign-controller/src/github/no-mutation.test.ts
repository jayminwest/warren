import { describe, expect, test } from "bun:test";
import { BoundaryError } from "../errors.ts";
import { FakeGithubServer } from "./fake-server.ts";
import { assertReadMethod, BunFetchGithubTransport } from "./http-transport.ts";
import { REDACTED, redactHeaders, redactText, redactValue } from "./redact.ts";
import type { GithubReadRequest } from "./types.ts";

const TOKEN = "ghp_test-token-value-123";

describe("hard no-mutation boundary", () => {
	test("the production transport fails hard on POST before any I/O", async () => {
		let fetched = false;
		const transport = new BunFetchGithubTransport({
			token: TOKEN,
			fetchImpl: () => {
				fetched = true;
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
		});
		const request = { method: "POST" as unknown as "GET", path: "/repos/o/r/pulls" };
		await expect(transport.read(request as GithubReadRequest)).rejects.toBeInstanceOf(
			BoundaryError,
		);
		expect(fetched).toBe(false);
	});

	test("the same guard covers PATCH, PUT, and DELETE", async () => {
		const transport = new BunFetchGithubTransport();
		for (const method of ["PATCH", "PUT", "DELETE"]) {
			const request = { method: method as unknown as "GET", path: "/repos/o/r/issues/1" };
			await expect(transport.read(request as GithubReadRequest)).rejects.toMatchObject({
				name: "BoundaryError",
				code: "boundary_violated",
			});
		}
	});

	test("the fake server fails hard on non-GET/HEAD and records nothing", async () => {
		const server = new FakeGithubServer();
		for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
			const request = { method: method as unknown as "GET", path: "/repos/o/r/pulls" };
			await expect(server.read(request as GithubReadRequest)).rejects.toBeInstanceOf(BoundaryError);
		}
		expect(server.requestCount).toBe(0);
	});

	test("assertReadMethod is the single shared runtime guard", () => {
		expect(assertReadMethod("GET", "/x")).toBe("GET");
		expect(assertReadMethod("HEAD", "/x")).toBe("HEAD");
		expect(() => assertReadMethod("POST", "/x")).toThrow(BoundaryError);
	});

	test("no transport implementation exposes a mutation method", () => {
		const impls = [new BunFetchGithubTransport({ token: TOKEN }), new FakeGithubServer()];
		for (const impl of impls) {
			const names = [
				...Object.getOwnPropertyNames(Object.getPrototypeOf(impl)),
				...Object.getOwnPropertyNames(impl),
			];
			for (const name of names) {
				const lower = name.toLowerCase();
				expect(
					lower === "post" ||
						lower === "patch" ||
						lower === "put" ||
						lower === "delete" ||
						lower === "write" ||
						lower === "send",
				).toBe(false);
			}
		}
	});
});

describe("token redaction", () => {
	test("redactHeaders replaces the authorization header", () => {
		const redacted = redactHeaders(
			{ Authorization: `Bearer ${TOKEN}`, accept: "application/json", "x-scope": TOKEN },
			TOKEN,
		);
		expect(redacted.authorization).toBe(REDACTED);
		expect(redacted["x-scope"]).toBe(REDACTED);
	});

	test("redactText scrubs every occurrence of the secret", () => {
		expect(redactText(`token ${TOKEN} leaked twice ${TOKEN}`, TOKEN)).not.toContain(TOKEN);
	});

	test("redactValue deep-scrubs nested JSON", () => {
		const redacted = redactValue(
			{ headers: { authorization: `Bearer ${TOKEN}` }, note: `see ${TOKEN}` },
			TOKEN,
		);
		expect(JSON.stringify(redacted)).not.toContain(TOKEN);
	});

	test("a transport network failure never leaks the credential", async () => {
		const transport = new BunFetchGithubTransport({
			token: TOKEN,
			fetchImpl: () => {
				throw new Error(`connection refused while holding ${TOKEN}`);
			},
		});
		try {
			await transport.read({ method: "GET", path: "/repos/o/r" });
			expect.unreachable();
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(TOKEN);
			expect(
				(error as { requestHeaders: Record<string, string> }).requestHeaders.authorization,
			).toBe(REDACTED);
		}
	});

	test("the production transport sends the bearer token but records stay redacted", async () => {
		const sentHeaders: Record<string, string> = {};
		const transport = new BunFetchGithubTransport({
			token: TOKEN,
			baseUrl: "https://fake.github.test",
			fetchImpl: (_url, init) => {
				for (const [key, value] of Object.entries(init?.headers ?? {})) {
					sentHeaders[key.toLowerCase()] = String(value);
				}
				return Promise.resolve(new Response("{}", { status: 200, headers: { etag: '"e1"' } }));
			},
		});
		const response = await transport.read({ method: "GET", path: "/repos/o/r" });
		expect(response.status).toBe(200);
		expect(sentHeaders.authorization).toBe(`Bearer ${TOKEN}`);
	});
});
